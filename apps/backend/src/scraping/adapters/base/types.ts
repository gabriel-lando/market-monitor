import type { NormalizedListing } from '@market-monitor/shared';

export interface ScrapeLogger {
  info(payload: unknown, message?: string): void;
  debug?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

export interface ScrapedCategory {
  sourceKey: string;
  sourceId: string;
  name: string;
  slug: string;
  url: string;
  depth: number;
  path: string[];
  parentSourceKey: string | null;
  isLeaf: boolean;
}

export interface ScrapedCategoryPage {
  category: ScrapedCategory;
  listings: NormalizedListing[];
}

export interface MarketAdapter {
  readonly marketCode: string;
  discoverCategories(logger: ScrapeLogger): Promise<ScrapedCategory[]>;
  scrapeCategory(category: ScrapedCategory, logger: ScrapeLogger): Promise<ScrapedCategoryPage>;
}
