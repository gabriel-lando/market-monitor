import { createDbPool } from '@market-monitor/db';

import { getAppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import type { ReclassifyListingsRequest } from '../scraping/jobs/reclassify-listings.js';
import { runReclassifyListings } from '../scraping/jobs/reclassify-listings.js';

function parseArgs(argv: string[]): ReclassifyListingsRequest {
  let market: string | undefined;
  let dryRun = false;
  let onlySourceSeed = false;
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run' || arg === '--dry_run') {
      dryRun = true;
      continue;
    }

    if (arg === '--only-source-seed' || arg === '--only_source_seed') {
      onlySourceSeed = true;
      continue;
    }

    if (arg === '--limit' && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
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
    market: market ?? 'carrefour',
    dry_run: dryRun,
    only_source_seed: onlySourceSeed,
    limit,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = getAppConfig();
const logger = createLogger(config.logLevel, config.scrapingEnabled ? 'writer' : 'readonly', config.appEnv);
const db = createDbPool(config.databaseUrl);

try {
  const result = await runReclassifyListings(
    {
      logger,
      db,
    },
    args,
  );

  logger.info(result, 'Reclassification command completed.');
} finally {
  await db.end();
}
