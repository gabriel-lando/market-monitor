import type { FastifyPluginAsync } from 'fastify';

import type { HistoryPoint } from '@market-monitor/shared';

export const listingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/listings/:listingId', async (request, reply) => {
    const { listingId } = request.params as { listingId: string };
    const result = await app.db.query(
      `
        SELECT
          ml.id,
          ml.source_name,
          ml.product_url,
          ml.match_status,
          m.code AS market_code,
          m.name AS market_name
        FROM market_listings ml
        JOIN markets m ON m.id = ml.market_id
        WHERE ml.id = $1
      `,
      [listingId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: { code: 'LISTING_NOT_FOUND', message: 'Listing was not found.' },
        request_id: request.id,
      });
    }

    return {
      data: result.rows[0],
    };
  });

  app.get('/listings/:listingId/history', async (request, reply) => {
    const { listingId } = request.params as { listingId: string };
    const query = request.query as { interval?: string; from?: string; to?: string };

    const exists = await app.db.query(`SELECT 1 FROM market_listings WHERE id = $1`, [listingId]);
    if ((exists.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: { code: 'LISTING_NOT_FOUND', message: 'Listing was not found.' },
        request_id: request.id,
      });
    }

    const now = new Date();
    const fromDate = query.from ? new Date(query.from) : query.interval === 'all' ? null : new Date(now.setMonth(now.getMonth() - 6));
    const toDate = query.to ? new Date(query.to) : null;
    const values: unknown[] = [listingId];
    const clauses: string[] = [];

    if (fromDate) {
      values.push(fromDate.toISOString().slice(0, 10));
      clauses.push(`snapshot_date >= $${values.length}`);
    }

    if (toDate) {
      values.push(toDate.toISOString().slice(0, 10));
      clauses.push(`snapshot_date <= $${values.length}`);
    }

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
        WHERE ps.market_listing_id = $1
        ${clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : ''}
        ORDER BY ps.snapshot_date ASC, ps.captured_at ASC
      `,
      values,
    );

    return {
      data: {
        listing_id: listingId,
        history: result.rows,
      },
    };
  });
};
