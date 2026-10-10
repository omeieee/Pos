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

/**
 * The data controller and the contact for data requests named in the Thai privacy notice (owner,
 * 2026-10-03: an individual, "omeie"). Draft for owner review: design/privacy-notice-th.md. These
 * are the defaults; `PRIVACY_CONTROLLER_NAME` and `PRIVACY_CONTACT_EMAIL` override them.
 */
export const DEFAULT_PRIVACY = {
  controller: 'omeie',
  contactEmail: 'omeza25482548@gmail.com',
} as const;

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
    // The shop's LINE channels (the TEST OA in development; real customers never get test
    // messages). All optional: without them the webhook answers 503 and nothing is sent.
    LINE_CHANNEL_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    LINE_CHANNEL_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    LINE_CHANNEL_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    LINE_LIFF_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    PRIVACY_CONTROLLER_NAME: z.preprocess(
      emptyToUndefined,
      z.string().min(1).max(100).default(DEFAULT_PRIVACY.controller),
    ),
    PRIVACY_CONTACT_EMAIL: z.preprocess(
      emptyToUndefined,
      z.email().default(DEFAULT_PRIVACY.contactEmail),
    ),
    /** Where transfer slip images are kept (D-24): a directory on a volume, never in the image. */
    SLIP_DIR: z.preprocess(emptyToUndefined, z.string().min(1).default('/data/slips')),
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
  /** Secrets: never log them. Each is undefined when its variable is not set. */
  line: {
    channelId: string | undefined;
    channelSecret: string | undefined;
    channelAccessToken: string | undefined;
    liffId: string | undefined;
  };
  /** Named in the privacy notice the LINE bot sends. */
  privacy: { controller: string; contactEmail: string };
  /** Directory of the slip image files. */
  slipDir: string;
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
    line: {
      channelId: e.LINE_CHANNEL_ID,
      channelSecret: e.LINE_CHANNEL_SECRET,
      channelAccessToken: e.LINE_CHANNEL_ACCESS_TOKEN,
      liffId: e.LINE_LIFF_ID,
    },
    privacy: { controller: e.PRIVACY_CONTROLLER_NAME, contactEmail: e.PRIVACY_CONTACT_EMAIL },
    slipDir: e.SLIP_DIR,
  };
}
