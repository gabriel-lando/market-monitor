import { UnsupportedMarketError } from '../jobs/errors.js';

import { ZaffariAdapter } from './zaffari/zaffari-adapter.js';

const adapters = new Map([['zaffari', new ZaffariAdapter()]]);

export function getSupportedMarketCodes() {
  return [...adapters.keys()];
}

export function getMarketAdapter(marketCode: string) {
  const adapter = adapters.get(marketCode);

  if (!adapter) {
    throw new UnsupportedMarketError(marketCode);
  }

  return adapter;
}
