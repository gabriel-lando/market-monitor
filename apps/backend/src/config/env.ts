import { z } from 'zod';

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel, type RuntimeMode } from '@market-monitor/shared';

const runtimeModes = ['prod', 'dev-ui-validation', 'dev-scrape-sandbox', 'local'] as const;

const localTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const normalizeEnvValue = (value: string | undefined) => value?.trimEnd();

const normalizeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).map(([key, value]) => [key, normalizeEnvValue(value)]));

const booleanFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    APP_ENV: z.enum(runtimeModes).default('local'),
    SCRAPING_ENABLED: booleanFromString(false),
    SCHEDULER_ENABLED: booleanFromString(false),
    SCHEDULED_SCRAPE_TIME_LOCAL: z.string().regex(localTimePattern, 'SCHEDULED_SCRAPE_TIME_LOCAL must use HH:MM 24-hour format').default('06:00'),
    SCHEDULED_SCRAPE_MARKETS: z.string().default(''),
    MIGRATIONS_ENABLED: booleanFromString(false),
    LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    INTERNAL_API_KEY: z.string().min(1).optional(),
    VITE_API_BASE_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.SCRAPING_ENABLED && env.MIGRATIONS_ENABLED && env.APP_ENV === 'dev-ui-validation') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MIGRATIONS_ENABLED must be false when APP_ENV is dev-ui-validation and scraping is disabled',
        path: ['MIGRATIONS_ENABLED'],
      });
    }
  });

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  appEnv: RuntimeMode;
  scrapingEnabled: boolean;
  schedulerEnabled: boolean;
  scheduledScrapeTimeLocal: string;
  scheduledScrapeMarkets: string[];
  migrationsEnabled: boolean;
  logLevel: LogLevel;
  internalApiKey?: string;
  viteApiBaseUrl?: string;
};

export function getAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(normalizeEnv(env));

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    appEnv: parsed.APP_ENV,
    scrapingEnabled: parsed.SCRAPING_ENABLED,
    schedulerEnabled: parsed.SCHEDULER_ENABLED,
    scheduledScrapeTimeLocal: parsed.SCHEDULED_SCRAPE_TIME_LOCAL,
    scheduledScrapeMarkets: parsed.SCHEDULED_SCRAPE_MARKETS.split(',')
      .map((market) => market.trim())
      .filter((market) => market.length > 0),
    migrationsEnabled: parsed.MIGRATIONS_ENABLED,
    logLevel: parsed.LOG_LEVEL,
    internalApiKey: parsed.INTERNAL_API_KEY,
    viteApiBaseUrl: parsed.VITE_API_BASE_URL,
  };
}
