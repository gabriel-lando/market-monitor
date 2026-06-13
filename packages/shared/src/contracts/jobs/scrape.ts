import { z } from 'zod';

export const scrapeJobRequestSchema = z.object({
  market: z.string().min(1),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  reason: z.string().min(1).optional(),
});

export type ScrapeJobRequest = z.infer<typeof scrapeJobRequestSchema>;
