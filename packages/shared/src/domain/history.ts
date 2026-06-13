export const HISTORY_INTERVALS = ['30d', '90d', '6m', '1y', '2y', '5y', 'all'] as const;

export type HistoryInterval = (typeof HISTORY_INTERVALS)[number];

export const DEFAULT_HISTORY_INTERVAL: HistoryInterval = '6m';

export function isHistoryInterval(value: string): value is HistoryInterval {
  return HISTORY_INTERVALS.includes(value as HistoryInterval);
}
