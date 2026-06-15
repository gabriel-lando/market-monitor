import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { SCRAPING_DISABLED_ERROR_CODE, type ScrapeJobRequest } from '@market-monitor/shared';

import { ScrapingDisabledError } from '../../../scraping/jobs/errors.js';
import { runScrapeOnce } from '../../../scraping/jobs/run-scrape-once.js';

const ScrapeRequestSchema = z.object({
  market: z.string().min(1),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  reason: z.string().min(1).optional(),
});

export const internalJobRoutes: FastifyPluginAsync = async (app) => {
  app.post('/jobs/scrape', async (request, reply) => {
    if (!app.config.scrapingEnabled) {
      return reply.code(409).send({
        error: {
          code: SCRAPING_DISABLED_ERROR_CODE,
          message: 'Scraping is disabled for this deployment.',
        },
        request_id: request.id,
      });
    }

    const payload = ScrapeRequestSchema.parse(request.body) as ScrapeJobRequest;

    const startedAt = new Date().toISOString();

    setImmediate(() => {
      void runScrapeOnce(
        {
          config: app.config,
          logger: app.log,
          db: app.db,
        },
        payload,
      ).catch((error) => {
        if (error instanceof ScrapingDisabledError) {
          app.log.warn({ market: payload.market, err: error }, 'Scrape job aborted because scraping is disabled.');
          return;
        }

        app.log.error({ market: payload.market, err: error }, 'Background scrape job failed.');
      });
    });

    return reply.code(202).send({
      data: {
        status: 'accepted',
        market: payload.market,
        started_at: startedAt,
        message: 'Scrape job accepted and started asynchronously.',
      },
      request_id: request.id,
    });
  });

  app.get('/jobs/runs', async (request) => {
    const query = request.query as { market?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const offset = Number(query.offset ?? 0);
    const values: unknown[] = [];
    const filters: string[] = [];

    if (query.market) {
      values.push(query.market);
      filters.push(`m.code = $${values.length}`);
    }

    values.push(limit, offset);

    const result = await app.db.query(
      `
        SELECT
          cr.id,
          cr.job_name,
          cr.trigger_source,
          cr.status,
          cr.started_at,
          cr.finished_at,
          cr.discovered_count,
          cr.ingested_count,
          cr.matched_count,
          cr.unmatched_count,
          cr.error_count,
          cr.error_summary,
          m.code AS market_code
        FROM collection_runs cr
        JOIN markets m ON m.id = cr.market_id
        ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY cr.started_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `,
      values,
    );

    return {
      data: result.rows,
      meta: {
        limit,
        offset,
        total: result.rows.length,
        has_more: false,
      },
    };
  });

  app.get('/jobs/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const result = await app.db.query(
      `
        SELECT *
        FROM collection_runs
        WHERE id = $1
      `,
      [runId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return reply.code(404).send({
        error: { code: 'RUN_NOT_FOUND', message: 'Run was not found.' },
        request_id: request.id,
      });
    }

    return { data: result.rows[0] };
  });
};
