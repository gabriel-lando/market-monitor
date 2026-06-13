import type { Pool } from 'pg';

import type { AppConfig } from '../config/env.js';

import { ScrapeAlreadyRunningError } from '../scraping/jobs/errors.js';
import { runScrapeOnce } from '../scraping/jobs/run-scrape-once.js';
import { getSupportedMarketCodes } from '../scraping/adapters/index.js';

interface SchedulerLogger {
  info(payload: unknown, message?: string): void;
  debug(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
}

interface SchedulerDependencies {
  config: AppConfig;
  logger: SchedulerLogger;
  db: Pool;
}

function getNextRunAt(now: Date, scheduleTimeLocal: string) {
  const [hourText, minuteText] = scheduleTimeLocal.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const nextRunAt = new Date(now);

  nextRunAt.setHours(hour, minute, 0, 0);

  if (nextRunAt.getTime() <= now.getTime()) {
    nextRunAt.setDate(nextRunAt.getDate() + 1);
  }

  return nextRunAt;
}

function getSchedulerTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? 'container-default';
}

async function runScheduledScrapes(dependencies: SchedulerDependencies, markets: string[]) {
  const { config, logger, db } = dependencies;

  for (const market of markets) {
    try {
      const result = await runScrapeOnce(
        {
          config,
          logger,
          db,
        },
        {
          market,
          reason: 'daily-scheduler',
        },
      );

      logger.info(
        {
          market,
          run_id: result.run_id,
          started_at: result.started_at,
          finished_at: result.finished_at,
          counts: result.counts,
        },
        'Scheduled scrape completed.',
      );
    } catch (error) {
      if (error instanceof ScrapeAlreadyRunningError) {
        logger.info({ market, error: error.message }, 'Scheduled scrape skipped because another run already holds the market lock.');
        continue;
      }

      logger.error({ market, error }, 'Scheduled scrape failed.');
    }
  }
}

export function registerScheduler(dependencies: SchedulerDependencies) {
  const { config, logger } = dependencies;

  if (!config.scrapingEnabled) {
    logger.info('SCRAPING_ENABLED=false; scheduler registration skipped.');
    return {
      close() {
        logger.debug('Scheduler close called with scraping disabled.');
      },
    };
  }

  if (!config.schedulerEnabled) {
    logger.info('SCHEDULER_ENABLED=false; daily scrape scheduler skipped.');
    return {
      close() {
        logger.debug('Scheduler close called with scheduler disabled.');
      },
    };
  }

  const markets = config.scheduledScrapeMarkets.length > 0 ? config.scheduledScrapeMarkets : getSupportedMarketCodes();

  if (markets.length === 0) {
    logger.warn('Scheduler enabled, but no supported markets are configured.');
    return {
      close() {
        logger.debug('Scheduler close called with no configured markets.');
      },
    };
  }

  const timeZone = getSchedulerTimeZone();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const scheduleNextRun = () => {
    if (closed) {
      return;
    }

    const now = new Date();
    const nextRunAt = getNextRunAt(now, config.scheduledScrapeTimeLocal);
    const delayMs = Math.max(nextRunAt.getTime() - now.getTime(), 0);

    logger.info(
      {
        markets,
        schedule_time_local: config.scheduledScrapeTimeLocal,
        time_zone: timeZone,
        next_run_at: nextRunAt.toISOString(),
        delay_ms: delayMs,
      },
      'Scheduled next daily scrape run.',
    );

    timer = setTimeout(async () => {
      if (closed) {
        return;
      }

      logger.info(
        {
          markets,
          schedule_time_local: config.scheduledScrapeTimeLocal,
          time_zone: timeZone,
          triggered_at: new Date().toISOString(),
        },
        'Daily scrape scheduler triggered.',
      );

      try {
        await runScheduledScrapes(dependencies, markets);
      } finally {
        scheduleNextRun();
      }
    }, delayMs);
  };

  logger.info(
    {
      markets,
      schedule_time_local: config.scheduledScrapeTimeLocal,
      time_zone: timeZone,
    },
    'Daily scrape scheduler registered.',
  );

  scheduleNextRun();

  return {
    close() {
      closed = true;

      if (timer) {
        clearTimeout(timer);
      }

      logger.debug('Scheduler close called.');
    },
  };
}
