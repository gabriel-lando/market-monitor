import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import type { Pool } from 'pg';

import type { AppConfig } from '../config/env.js';
import { publicRoutes } from '../http/routes/public/index.js';
import { internalRoutes } from '../http/routes/internal/index.js';
import { registerStaticAssets } from '../http/static/register-static.js';
import { createLogger } from '../logging/logger.js';

export function createApp(config: AppConfig, db: Pool) {
  const deploymentMode = config.scrapingEnabled ? 'writer' : 'readonly';
  const logger = createLogger(config.logLevel, deploymentMode, config.appEnv);
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });

  app.decorate('config', config);
  app.decorate('db', db);

  app.addHook('onRequest', (request, _reply, done) => {
    const logData = {
      method: request.method,
      url: request.url,
      remoteAddr: request.ip,
    };
    if (request.method === 'GET') {
      request.log.debug(logData, `${request.method} ${request.url}`);
    } else {
      request.log.info(logData, `${request.method} ${request.url}`);
    }
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed.');

    const maybeStatusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const statusCode = typeof maybeStatusCode === 'number' && maybeStatusCode >= 400 ? maybeStatusCode : reply.statusCode >= 400 ? reply.statusCode : 500;
    const errorMessage = error instanceof Error ? error.message : 'Unexpected error';
    const maybeCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const errorCode = typeof maybeCode === 'string' ? maybeCode : error instanceof Error ? error.name : 'INTERNAL_SERVER_ERROR';
    reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : errorCode,
        message: errorMessage,
      },
      request_id: request.id,
    });
  });

  app.register(cors, { origin: true });
  app.register(sensible);
  app.register(publicRoutes);
  app.register(internalRoutes);
  app.register(registerStaticAssets);

  return app;
}
