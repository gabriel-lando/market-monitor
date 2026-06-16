import { DEFAULT_HISTORY_INTERVAL, HISTORY_INTERVALS, type HistoryInterval, type HistoryPoint, type PaginationMeta, type ProductDetail, type ProductSearchResult } from '@market-monitor/shared';

const rawBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl && rawBaseUrl.trim().length > 0 ? rawBaseUrl : window.location.origin).replace(/\/$/, '');

interface SearchProductsOptions {
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
  signal?: AbortSignal;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { signal });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function listHistoryIntervals() {
  return HISTORY_INTERVALS;
}

export async function searchProducts(query: string, options: SearchProductsOptions = {}) {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set('q', query.trim());
  }

  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }

  if (options.offset !== undefined) {
    params.set('offset', String(options.offset));
  }

  if (options.includeTotal === false) {
    params.set('include_total', 'false');
  }

  return fetchJson<{ data: ProductSearchResult[]; meta: PaginationMeta }>(`/api/v1/products?${params.toString()}`, options.signal);
}

export async function getProduct(productId: string, signal?: AbortSignal) {
  return fetchJson<{ data: ProductDetail }>(`/api/v1/products/${productId}`, signal);
}

export async function getProductHistory(productId: string, interval: HistoryInterval = DEFAULT_HISTORY_INTERVAL, signal?: AbortSignal) {
  const params = new URLSearchParams();
  params.set('interval', interval);
  return fetchJson<{ data: { product_id: string; interval: HistoryInterval | null; history: HistoryPoint[] } }>(`/api/v1/products/${productId}/history?${params.toString()}`, signal);
}
