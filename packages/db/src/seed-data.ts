import type { Pool } from 'pg';

import { createDbPool } from './client.js';

interface SeedLogger {
  info(message: string): void;
}

const defaultLogger: SeedLogger = {
  info: (message) => {
    console.log(message);
  },
};

export async function seedBaseData(poolArg?: Pool, logger: SeedLogger = defaultLogger) {
  const ownedPool = poolArg ?? createDbPool();
  const pool = poolArg ?? ownedPool;

  const marketResult = await pool.query<{ id: string }>(`
    INSERT INTO markets (code, name, base_url, country_code, region, is_enabled)
    VALUES ('zaffari', 'Zaffari', 'https://www.zaffari.com.br', 'BR', 'RS', TRUE)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      base_url = EXCLUDED.base_url,
      country_code = EXCLUDED.country_code,
      region = EXCLUDED.region,
      is_enabled = EXCLUDED.is_enabled,
      updated_at = NOW()
    RETURNING id
  `);

  const marketId = marketResult.rows[0]?.id;

  if (marketId) {
    await pool.query(
      `
        INSERT INTO stores (market_id, code, name, scope_type, city, state, country_code, is_enabled)
        VALUES ($1, 'default', 'Default Market Scope', 'market', NULL, 'RS', 'BR', TRUE)
        ON CONFLICT (market_id, code) DO UPDATE SET
          name = EXCLUDED.name,
          scope_type = EXCLUDED.scope_type,
          state = EXCLUDED.state,
          country_code = EXCLUDED.country_code,
          is_enabled = EXCLUDED.is_enabled,
          updated_at = NOW()
      `,
      [marketId],
    );
  }

  const atacadaoMarketResult = await pool.query<{ id: string }>(`
    INSERT INTO markets (code, name, base_url, country_code, region, is_enabled)
    VALUES ('atacadao', 'Atacadao', 'https://www.atacadao.com.br', 'BR', 'BR', TRUE)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      base_url = EXCLUDED.base_url,
      country_code = EXCLUDED.country_code,
      region = EXCLUDED.region,
      is_enabled = EXCLUDED.is_enabled,
      updated_at = NOW()
    RETURNING id
  `);

  const atacadaoMarketId = atacadaoMarketResult.rows[0]?.id;

  if (atacadaoMarketId) {
    await pool.query(
      `
        INSERT INTO stores (market_id, code, name, scope_type, city, state, country_code, is_enabled)
        VALUES ($1, 'default', 'Default Market Scope', 'market', NULL, NULL, 'BR', TRUE)
        ON CONFLICT (market_id, code) DO UPDATE SET
          name = EXCLUDED.name,
          scope_type = EXCLUDED.scope_type,
          state = EXCLUDED.state,
          country_code = EXCLUDED.country_code,
          is_enabled = EXCLUDED.is_enabled,
          updated_at = NOW()
      `,
      [atacadaoMarketId],
    );
  }

  logger.info('Seeded base market data.');

  if (poolArg === undefined) {
    await ownedPool.end();
  }
}
