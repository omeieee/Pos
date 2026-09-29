import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** postgres:// or postgresql:// only. The message never echoes the value (it holds a password). */
export const databaseUrlSchema = z
  .string({ error: 'is required' })
  .regex(/^postgres(ql)?:\/\/\S+$/, { error: 'must be a postgres:// connection string' });

const originSchema = z.url({ protocol: /^https?$/, error: 'each entry must be an http(s) origin' });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: databaseUrlSchema,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Comma-separated allow-list (D-19: native app origins get added here later). Empty = no CORS. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(originSchema)),
  SENTRY_DSN: z.preprocess(emptyToUndefined, z.url().optional()),
  GIT_SHA: z.preprocess(emptyToUndefined, z.string().default('dev')),
});

export type Env = z.output<typeof envSchema>;

export type Config = {
  nodeEnv: Env['NODE_ENV'];
  databaseUrl: string;
  port: number;
  corsOrigins: string[];
  sentryDsn: string | undefined;
  version: string;
};

export class ConfigError extends Error {}

/**
 * Validates the environment. On failure the error lists variable names and rules only,
 * never values, so DATABASE_URL and the Sentry DSN cannot end up in logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS,
    sentryDsn: e.SENTRY_DSN,
    version: e.GIT_SHA,
  };
}
