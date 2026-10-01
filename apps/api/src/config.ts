import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** postgres:// or postgresql:// only. The message never echoes the value (it holds a password). */
export const databaseUrlSchema = z
  .string({ error: 'is required' })
  .regex(/^postgres(ql)?:\/\/\S+$/, { error: 'must be a postgres:// connection string' });

/**
 * 32 random bytes as standard base64 (`openssl rand -base64 32`): 43 characters and one `=`.
 * It becomes a Buffer here. The message never echoes the value.
 */
export const authSecretKeySchema = z
  .string({ error: 'is required' })
  .regex(/^[A-Za-z0-9+/]{43}=$/, {
    error: 'must be 32 random bytes in base64 (openssl rand -base64 32)',
  })
  .transform((v) => Buffer.from(v, 'base64'));

const originSchema = z.url({ protocol: /^https?$/, error: 'each entry must be an http(s) origin' });

/** postgres-js reads both `sslmode` and `ssl`; either one switching TLS off means plaintext. */
function disablesTls(databaseUrl: string): boolean {
  try {
    const params = new URL(databaseUrl).searchParams;
    return [params.get('sslmode'), params.get('ssl')].some(
      (v) => v !== null && ['disable', 'false'].includes(v.toLowerCase()),
    );
  } catch {
    return false; // not a parsable URL: the postgres client rejects it (and fails closed to TLS)
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: databaseUrlSchema,
    /** Master key for the TOTP-secret encryption and the PIN and recovery-code peppers. */
    AUTH_SECRET_KEY: authSecretKeySchema,
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
  })
  .refine((e) => e.NODE_ENV !== 'production' || !disablesTls(e.DATABASE_URL), {
    path: ['DATABASE_URL'],
    error: 'must not switch TLS off (sslmode=disable) in production',
  });

export type Env = z.output<typeof envSchema>;

export type Config = {
  nodeEnv: Env['NODE_ENV'];
  databaseUrl: string;
  /** 32 bytes. Never log it. */
  authSecretKey: Buffer;
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
    authSecretKey: e.AUTH_SECRET_KEY,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS,
    sentryDsn: e.SENTRY_DSN,
    version: e.GIT_SHA,
  };
}
