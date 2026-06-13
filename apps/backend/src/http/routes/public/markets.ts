import type { FastifyPluginAsync } from 'fastify';

import type { MarketSummary } from '@market-monitor/shared';

export const marketRoutes: FastifyPluginAsync = async (app) => {
  app.get('/markets', async () => {
    const result = await app.db.query<MarketSummary>(
      `
        SELECT id, code, name, base_url, is_enabled
        FROM markets
        WHERE is_enabled = TRUE
        ORDER BY name ASC
      `,
    );

    return {
      data: result.rows,
      meta: {
        total: result.rowCount ?? result.rows.length,
      },
    };
  });
};
