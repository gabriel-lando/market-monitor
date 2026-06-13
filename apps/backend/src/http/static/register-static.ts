import { existsSync } from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

export const registerStaticAssets: FastifyPluginAsync = async (app) => {
  const staticRoot = path.resolve(process.cwd(), 'apps/frontend/dist');

  if (!existsSync(staticRoot)) {
    app.log.info({ staticRoot }, 'Frontend dist directory not found; static asset serving skipped.');
    return;
  }

  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource was not found.',
      },
      request_id: request.id,
    });
  });
};
