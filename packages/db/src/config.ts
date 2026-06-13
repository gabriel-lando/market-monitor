import { z } from 'zod';

const DatabaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

export function getDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  return DatabaseEnvSchema.parse(env);
}
