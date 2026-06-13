import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    return {
      data: {
        status: 'ok',
        now: new Date().toISOString(),
        environment: app.config.appEnv,
        scraping_enabled: app.config.scrapingEnabled,
        migrations_enabled: app.config.migrationsEnabled,
        log_level: app.config.logLevel,
      },
    };
  });
};
