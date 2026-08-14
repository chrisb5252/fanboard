import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment contract for the backend.
 *
 * Validation is lazy and memoised on purpose: evaluating it at module scope
 * would make `next build` fail on machines and CI runners that have no
 * `.env.local`, even though nothing at build time needs a database.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  THESPORTSDB_API_KEY: z.string().min(1, 'THESPORTSDB_API_KEY is required'),
  NEXT_PUBLIC_API_URL: z.string().min(1, 'NEXT_PUBLIC_API_URL is required'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Returns the validated environment, throwing a single actionable error that
 * lists every missing or malformed variable at once.
 *
 * Next.js already loads `.env.local` for its own processes; the explicit
 * dotenv call (non-overriding) is what makes standalone scripts — migrations,
 * ingest jobs, the grading worker — behave identically.
 */
export function getEnv(): Env {
  if (cachedEnv !== null) {
    return cachedEnv;
  }

  loadDotenv({ path: '.env.local', override: false, quiet: true });

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy packages/backend/.env.example to packages/backend/.env.local and fill it in.',
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
