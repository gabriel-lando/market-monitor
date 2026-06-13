import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { createDbPool } from './client.js';

interface MigrationLogger {
  info(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
  error?(message: string, details?: unknown): void;
}

const defaultLogger: MigrationLogger = {
  info: (message, details) => {
    console.log(message, details ?? '');
  },
  warn: (message, details) => {
    console.warn(message, details ?? '');
  },
  error: (message, details) => {
    console.error(message, details ?? '');
  },
};

function getMigrationsDirectory() {
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

export async function runMigrations(poolArg?: Pool, logger: MigrationLogger = defaultLogger) {
  const ownedPool = poolArg ?? createDbPool();
  const pool = poolArg ?? ownedPool;
  const migrationFiles = readdirSync(getMigrationsDirectory())
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const migrationFile of migrationFiles) {
    const alreadyApplied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations WHERE name = $1', [migrationFile]);

    if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
      logger.info(`Skipping migration ${migrationFile}; already applied.`);
      continue;
    }

    const migrationSql = readFileSync(`${getMigrationsDirectory()}${migrationFile}`, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(migrationSql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migrationFile]);
      await client.query('COMMIT');
      logger.info(`Applied migration ${migrationFile}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error?.(`Failed migration ${migrationFile}.`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  if (poolArg === undefined) {
    await ownedPool.end();
  }
}
