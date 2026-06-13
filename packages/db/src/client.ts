import { Pool } from 'pg';

import { getDatabaseConfig } from './config.js';

let sharedPool: Pool | null = null;

export function createDbPool(connectionString = getDatabaseConfig().DATABASE_URL) {
  return new Pool({ connectionString });
}

export function getDbPool() {
  if (sharedPool === null) {
    sharedPool = createDbPool();
  }

  return sharedPool;
}

export async function closeDbPool() {
  if (sharedPool !== null) {
    await sharedPool.end();
    sharedPool = null;
  }
}
