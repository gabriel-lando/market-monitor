import { z } from 'zod';

export const marketSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  isEnabled: z.boolean(),
  scrapingEnabled: z.boolean(),
  lastRunStatus: z.enum(['idle', 'running', 'completed', 'failed']).default('idle'),
});

export const listMarketsResponseSchema = z.object({
  data: z.array(marketSummarySchema),
});

export type MarketSummary = z.infer<typeof marketSummarySchema>;
export type ListMarketsResponse = z.infer<typeof listMarketsResponseSchema>;
