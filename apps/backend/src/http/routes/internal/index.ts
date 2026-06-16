import type { FastifyPluginAsync } from 'fastify';

import { internalJobRoutes } from './jobs.js';

export const internalRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', (request, reply, done) => {
    const configuredKey = app.config.internalApiKey;
    if (!configuredKey) {
      void reply.code(503).send({
        error: {
          code: 'INTERNAL_API_NOT_CONFIGURED',
          message: 'INTERNAL_API_KEY is not configured for this deployment.',
        },
        request_id: request.id,
      });
      return;
    }

    const headerValue = request.headers['x-internal-api-key'];
    const providedKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!providedKey || providedKey !== configuredKey) {
      void reply.code(401).send({
        error: {
          code: 'INTERNAL_API_UNAUTHORIZED',
          message: 'Missing or invalid internal API key.',
        },
        request_id: request.id,
      });
      return;
    }

    done();
  });

  await app.register(internalJobRoutes, { prefix: '/api/v1/internal' });
};
