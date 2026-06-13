export interface ScrapeJobRequest {
  market: string;
  force?: boolean;
  dry_run?: boolean;
  reason?: string;
}

export interface ScrapeJobCounts {
  categoriesDiscovered: number;
  categoriesScraped: number;
  listingsSeen: number;
  listingsIngested: number;
  productsCreated: number;
  matchedProducts: number;
  snapshotsUpserted: number;
  rawPayloadsStored: number;
  skippedListings: number;
}

export interface ScrapeJobResult {
  market: string;
  run_id?: string;
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  message: string;
  counts: ScrapeJobCounts;
}
