import { createDbPool, runMigrations, seedBaseData } from '@market-monitor/db';

import { getAppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { runScrapeOnce } from '../scraping/jobs/run-scrape-once.js';

const config = getAppConfig();
const logger = createLogger(config.logLevel, config.scrapingEnabled ? 'writer' : 'readonly', config.appEnv);
const db = createDbPool(config.databaseUrl);

if (config.migrationsEnabled) {
  await runMigrations(db, logger);
  await seedBaseData(db, logger);
}

const market = process.argv[2] ?? 'zaffari';
const result = await runScrapeOnce(
  {
    config,
    logger,
    db,
  },
  { market },
);

logger.info(result, 'Scrape command completed.');
await db.end();
