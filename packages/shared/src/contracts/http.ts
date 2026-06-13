import type { HistoryInterval } from '../domain/history.js';

export type SearchResultType = 'canonical_product' | 'unmatched_listing';

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id?: string;
}

export interface MarketSummary {
  id: string;
  code: string;
  name: string;
  base_url: string | null;
  is_enabled: boolean;
}

export interface ProductSearchResult {
  id: string;
  result_type: SearchResultType;
  name: string;
  market_code: string | null;
  latest_price_cents: number | null;
}

export interface ProductLinkedMarket {
  id: string;
  market_code: string;
  market_name: string;
  price_cents: number | null;
  snapshot_date: string | null;
  captured_at: string | null;
  availability_status: string | null;
}

export interface ProductDetail {
  id: string;
  canonical_name: string;
  normalized_name: string;
  brand: string | null;
  measurement_unit: string | null;
  unit_value: number | null;
  pack_quantity: number | null;
  image_url: string | null;
  comparison_ready: boolean;
  linked_markets: ProductLinkedMarket[];
}

export interface HistoryPoint {
  market_code: string;
  market_name: string;
  captured_at: string;
  snapshot_date: string;
  price_cents: number;
  availability_status: string;
}

export interface HistoryQuery {
  market?: string;
  interval?: HistoryInterval;
  from?: string;
  to?: string;
}
