import { createDbPool, runMigrations, seedBaseData } from '@market-monitor/db';

import { getAppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { runScrapeOnce } from '../scraping/jobs/run-scrape-once.js';

function parseScrapeOnceArgs(argv: string[]) {
  let market: string | undefined;
  let dryRun = false;
  let force = false;
  let reason: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run' || arg === '--dry_run') {
      dryRun = true;
      continue;
    }

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--reason' && index + 1 < argv.length) {
      reason = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
      continue;
    }

    if (arg.startsWith('-')) {
      continue;
    }

    if (!market) {
      market = arg;
    }
  }

  return {
    market: market ?? 'zaffari',
    dryRun,
    force,
    reason,
  };
}

const args = parseScrapeOnceArgs(process.argv.slice(2));
const config = getAppConfig();
const logger = createLogger(config.logLevel, config.scrapingEnabled ? 'writer' : 'readonly', config.appEnv);
const db = createDbPool(config.databaseUrl);

if (config.migrationsEnabled && !args.dryRun) {
  await runMigrations(db, logger);
  await seedBaseData(db, logger);
} else if (config.migrationsEnabled && args.dryRun) {
  logger.info({ market: args.market }, 'Skipping migrations and seed because dry-run is enabled.');
}

const result = await runScrapeOnce(
  {
    config,
    logger,
    db,
  },
  {
    market: args.market,
    dry_run: args.dryRun,
    force: args.force,
    reason: args.reason,
  },
);

logger.info(result, 'Scrape command completed.');
await db.end();
