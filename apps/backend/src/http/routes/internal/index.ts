import type { FastifyPluginAsync } from 'fastify';

import { internalJobRoutes } from './jobs.js';

export const internalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(internalJobRoutes, { prefix: '/api/v1/internal' });
};
