import type { Pool } from 'pg';

import type { AppConfig } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Pool;
  }
}
