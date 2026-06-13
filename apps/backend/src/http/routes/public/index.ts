import type { FastifyPluginAsync } from 'fastify';

import { healthRoutes } from './health.js';
import { listingRoutes } from './listings.js';
import { marketRoutes } from './markets.js';
import { productRoutes } from './products.js';

export const publicRoutes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(marketRoutes, { prefix: '/api/v1' });
  await app.register(productRoutes, { prefix: '/api/v1' });
  await app.register(listingRoutes, { prefix: '/api/v1' });
};
