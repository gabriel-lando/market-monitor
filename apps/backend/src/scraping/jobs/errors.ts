import { SCRAPING_DISABLED_ERROR_CODE } from '@market-monitor/shared';

export class ScrapingDisabledError extends Error {
  readonly code = SCRAPING_DISABLED_ERROR_CODE;
  readonly statusCode = 409;

  constructor(message = 'Scraping is disabled for this deployment.') {
    super(message);
    this.name = 'ScrapingDisabledError';
  }
}

export class UnsupportedMarketError extends Error {
  readonly code = 'UNSUPPORTED_MARKET';
  readonly statusCode = 400;

  constructor(marketCode: string) {
    super(`Unsupported market: ${marketCode}`);
    this.name = 'UnsupportedMarketError';
  }
}

export class ScrapeAlreadyRunningError extends Error {
  readonly code = 'SCRAPE_ALREADY_RUNNING';
  readonly statusCode = 409;

  constructor(marketCode: string) {
    super(`A scrape run is already active for market ${marketCode}.`);
    this.name = 'ScrapeAlreadyRunningError';
  }
}
