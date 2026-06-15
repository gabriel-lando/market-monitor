import type { Pool } from 'pg';

import type { AppConfig } from '../../config/env.js';
import type { ScrapeJobRequest, ScrapeJobResult } from '@market-monitor/shared';

import { getMarketAdapter } from '../adapters/index.js';
import { acquireMarketLock, createCollectionRun, createEmptyStats, mergeStats, persistListing, releaseMarketLock, resolveMarketContext, updateCollectionRun, upsertCategories } from '../pipeline/persist-run.js';
import { ScrapeAlreadyRunningError, ScrapingDisabledError } from './errors.js';

interface JobLogger {
  info(payload: unknown, message?: string): void;
  debug?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

interface RunScrapeOnceDependencies {
  config: AppConfig;
  logger: JobLogger;
  db: Pool;
}

export async function runScrapeOnce(dependencies: RunScrapeOnceDependencies, request: ScrapeJobRequest): Promise<ScrapeJobResult> {
  const { config, logger, db } = dependencies;

  if (!config.scrapingEnabled) {
    throw new ScrapingDisabledError();
  }

  const adapter = getMarketAdapter(request.market);
  const lockAcquired = await acquireMarketLock(db, adapter.marketCode);

  if (!lockAcquired) {
    throw new ScrapeAlreadyRunningError(adapter.marketCode);
  }

  const startedAt = new Date().toISOString();
  const stats = createEmptyStats();
  let runId: string | undefined;

  try {
    logger.info(
      {
        market: request.market,
        dry_run: request.dry_run ?? false,
        force: request.force ?? false,
        reason: request.reason ?? null,
      },
      'Starting scrape job.',
    );

    const marketContext = await resolveMarketContext(db, request.market);
    const categories = await adapter.discoverCategories(logger);
    const scrapeCategories = categories.filter((category) => category.depth === 1);

    stats.categoriesDiscovered = categories.length;

    let categoryIdBySourceKey = new Map<string, string>();
    if (!request.dry_run) {
      const run = await createCollectionRun(db, marketContext, request.market, request.dry_run ?? false, request.reason);
      runId = run.id;
      categoryIdBySourceKey = await upsertCategories(db, marketContext.marketId, categories);
    }

    for (const category of scrapeCategories) {
      const page = await adapter.scrapeCategory(category, logger);
      stats.categoriesScraped += 1;
      stats.listingsSeen += page.listings.length;

      for (const listing of page.listings) {
        if (request.dry_run) {
          continue;
        }

        if (!runId) {
          throw new Error('Collection run was not created for a non-dry run scrape.');
        }

        const persisted = await persistListing(db, marketContext, runId, categoryIdBySourceKey, listing);
        mergeStats(stats, persisted);
      }
    }

    const finishedAt = new Date().toISOString();

    if (runId) {
      await updateCollectionRun(db, runId, 'completed', stats);
    }

    return {
      market: request.market,
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      dry_run: request.dry_run ?? false,
      message: request.dry_run ? 'Dry run completed without database writes.' : `${request.market} scrape completed and persisted successfully.`,
      counts: stats,
    };
  } catch (error) {
    if (runId) {
      await updateCollectionRun(db, runId, 'failed', stats, error instanceof Error ? error.message : 'Unexpected scrape failure');
    }

    logger.error?.({ market: request.market, error }, 'Scrape job failed.');
    throw error;
  } finally {
    await releaseMarketLock(db, adapter.marketCode);
  }
}
