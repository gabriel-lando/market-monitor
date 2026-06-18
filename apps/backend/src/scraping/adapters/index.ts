import { UnsupportedMarketError } from '../jobs/errors.js';

import type { MarketAdapter } from './base/types.js';
import { AtacadaoAdapter } from './atacadao/atacadao-adapter.js';
import { CarrefourAdapter } from './carrefour/carrefour-adapter.js';
import { StokCenterAdapter } from './stokcenter/stokcenter-adapter.js';
import { ZaffariAdapter } from './zaffari/zaffari-adapter.js';

const adapters = new Map<string, MarketAdapter>([
  ['zaffari', new ZaffariAdapter()],
  ['atacadao', new AtacadaoAdapter()],
  ['carrefour', new CarrefourAdapter()],
  ['stokcenter', new StokCenterAdapter()],
]);

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
