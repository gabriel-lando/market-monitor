import { z } from 'zod';

export const healthResponseSchema = z.object({
  data: z.object({
    status: z.literal('ok'),
    environment: z.string(),
    scrapingEnabled: z.boolean(),
    migrationsEnabled: z.boolean(),
    logLevel: z.string(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
