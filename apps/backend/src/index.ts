import { createDbPool, runMigrations, seedBaseData } from '@market-monitor/db';

import { createApp } from './bootstrap/create-app.js';
import { getAppConfig } from './config/env.js';
import { createLogger } from './logging/logger.js';
import { registerScheduler } from './scheduler/register-scheduler.js';

const config = getAppConfig();
const logger = createLogger(config.logLevel, config.scrapingEnabled ? 'writer' : 'readonly', config.appEnv);
const db = createDbPool(config.databaseUrl);

if (config.migrationsEnabled) {
  logger.info('MIGRATIONS_ENABLED=true; running startup migrations.');
  await runMigrations(db, logger);
  await seedBaseData(db, logger);
} else {
  logger.info('MIGRATIONS_ENABLED=false; startup migrations skipped.');
}

const app = createApp(config, db);
const scheduler = registerScheduler({ config, logger, db });

const close = async () => {
  scheduler.close();
  await app.close();
  await db.end();
};

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await close();
  process.exit(0);
});

await app.listen({ host: config.host, port: config.port });
