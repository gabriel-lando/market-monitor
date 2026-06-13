import type { FastifyPluginAsync } from 'fastify';

import { DEFAULT_HISTORY_INTERVAL, HISTORY_INTERVALS, isHistoryInterval, type HistoryPoint, type ProductSearchResult } from '@market-monitor/shared';

import { buildProductSearchParams, PRODUCT_SEARCH_QUERY } from './product-search-query.js';
import { normalizeText } from '../../../scraping/pipeline/utils.js';

interface ProductSearchRow extends ProductSearchResult {
  total_count: number;
}

function resolveDateWindow(query: { interval?: string; from?: string; to?: string }) {
  if (query.from || query.to) {
    return {
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
    };
  }

  const interval = query.interval && isHistoryInterval(query.interval) ? query.interval : DEFAULT_HISTORY_INTERVAL;
  if (interval === 'all') {
    return { from: null, to: null };
  }

  const now = new Date();
  const from = new Date(now);

  switch (interval) {
    case '30d':
      from.setDate(now.getDate() - 30);
      break;
    case '90d':
      from.setDate(now.getDate() - 90);
      break;
    case '6m':
      from.setMonth(now.getMonth() - 6);
      break;
    case '1y':
      from.setFullYear(now.getFullYear() - 1);
      break;
    case '2y':
      from.setFullYear(now.getFullYear() - 2);
      break;
    case '5y':
      from.setFullYear(now.getFullYear() - 5);
      break;
    default:
      break;
  }

  return { from, to: null };
}

function buildHistoryFilters(args: { market?: string; from: Date | null; to: Date | null; parameterOffset?: number }) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let parameterIndex = args.parameterOffset ?? 1;

  if (args.market) {
    clauses.push(`m.code = $${parameterIndex}`);
    values.push(args.market);
    parameterIndex += 1;
  }

  if (args.from) {
    clauses.push(`ps.snapshot_date >= $${parameterIndex}`);
    values.push(args.from.toISOString().slice(0, 10));
    parameterIndex += 1;
  }

  if (args.to) {
    clauses.push(`ps.snapshot_date <= $${parameterIndex}`);
    values.push(args.to.toISOString().slice(0, 10));
  }

  return {
    clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    values,
  };
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  app.get('/products', async (request) => {
    const query = request.query as {
      q?: string;
      market?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(Number(query.limit ?? 20), 100);
    const offset = Number(query.offset ?? 0);
    const searchTerm = normalizeText(query.q?.trim());

    const searchResults = await app.db.query<ProductSearchRow>(
      PRODUCT_SEARCH_QUERY,
      buildProductSearchParams({
        searchTerm,
        market: query.market ?? null,
        limit,
        offset,
      }),
    );

    const total = searchResults.rows[0]?.total_count ?? 0;
    const data = searchResults.rows.map(({ total_count: _totalCount, ...result }) => result);

    return {
      data,
      meta: {
        limit,
        offset,
        total,
        has_more: offset + data.length < total,
      },
    };
  });

  app.get('/products/:productId', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const productResult = await app.db.query(
      `
        SELECT id, canonical_name, normalized_name, brand, measurement_unit, unit_value, pack_quantity, image_url
        FROM products
        WHERE id = $1
      `,
      [productId],
    );

    if ((productResult.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product was not found.',
        },
        request_id: request.id,
      });
    }

    const listingsResult = await app.db.query(
      `
        SELECT DISTINCT ON (m.code)
          ml.id,
          m.code AS market_code,
          m.name AS market_name,
          ps.price_cents,
          ps.snapshot_date,
          ps.captured_at,
          ps.availability_status
        FROM market_listings ml
        JOIN markets m ON m.id = ml.market_id
        LEFT JOIN price_snapshots ps ON ps.market_listing_id = ml.id
        WHERE ml.product_id = $1
        ORDER BY m.code, ps.snapshot_date DESC NULLS LAST, ps.captured_at DESC NULLS LAST
      `,
      [productId],
    );

    return {
      data: {
        ...productResult.rows[0],
        comparison_ready: listingsResult.rows.length > 1,
        linked_markets: listingsResult.rows,
      },
    };
  });

  app.get('/products/:productId/history', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const query = request.query as { market?: string; interval?: string; from?: string; to?: string };

    const exists = await app.db.query(`SELECT 1 FROM products WHERE id = $1`, [productId]);
    if ((exists.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product was not found.' },
        request_id: request.id,
      });
    }

    const window = resolveDateWindow(query);
    const filters = buildHistoryFilters({ market: query.market, from: window.from, to: window.to, parameterOffset: 2 });

    const result = await app.db.query<HistoryPoint>(
      `
        SELECT
          m.code AS market_code,
          m.name AS market_name,
          ps.captured_at::TEXT,
          ps.snapshot_date::TEXT,
          ps.price_cents,
          ps.availability_status
        FROM price_snapshots ps
        JOIN market_listings ml ON ml.id = ps.market_listing_id
        JOIN markets m ON m.id = ml.market_id
        WHERE ml.product_id = $1
        ${filters.clause}
        ORDER BY ps.snapshot_date ASC, ps.captured_at ASC
      `,
      [productId, ...filters.values],
    );

    return {
      data: {
        product_id: productId,
        interval: query.from || query.to ? null : query.interval && HISTORY_INTERVALS.includes(query.interval as never) ? query.interval : DEFAULT_HISTORY_INTERVAL,
        history: result.rows,
      },
    };
  });

  app.get('/products/:productId/compare', async (request, reply) => {
    const { productId } = request.params as { productId: string };

    const exists = await app.db.query(`SELECT canonical_name FROM products WHERE id = $1`, [productId]);
    if ((exists.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product was not found.' },
        request_id: request.id,
      });
    }

    const result = await app.db.query(
      `
        SELECT DISTINCT ON (m.code)
          m.code AS market_code,
          m.name AS market_name,
          ps.price_cents,
          ps.availability_status,
          ps.captured_at::TEXT,
          ps.snapshot_date::TEXT
        FROM market_listings ml
        JOIN markets m ON m.id = ml.market_id
        LEFT JOIN price_snapshots ps ON ps.market_listing_id = ml.id
        WHERE ml.product_id = $1
        ORDER BY m.code, ps.snapshot_date DESC NULLS LAST, ps.captured_at DESC NULLS LAST
      `,
      [productId],
    );

    return {
      data: {
        product_id: productId,
        comparison_ready: result.rows.length > 1,
        markets: result.rows,
      },
    };
  });
};
