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
    /**
     * Slip images and expense receipt photos on Cloudflare R2 (D-36). All four or none: with none,
     * the files stay on disk (SLIP_DIR). The secret is a credential: never log it.
     */
    R2_ACCOUNT_ID: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[0-9a-f]{32}$/)
        .optional(),
    ),
    R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    R2_BUCKET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
        .optional(),
    ),
    /**
     * Reads the amount on a slip with Tesseract on this machine (D-26), as a hint for staff only.
     * Default: on in production (the image has it), off elsewhere. `off` leaves slips unread.
     */
    SLIP_OCR: z.preprocess(emptyToUndefined, z.enum(['tesseract', 'off']).optional()),
    /** Tesseract languages. `tha+eng` reads the Thai labels; `eng` is lighter if the box is slow. */
    SLIP_OCR_LANG: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[a-z]{3}(\+[a-z]{3})*$/)
        .default('tha+eng'),
    ),
    /** The reader is killed after this long (the shop's server is small: the first tries are slow). */
    SLIP_OCR_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1000).max(300_000).default(60_000),
    ),
    /** Reads the small QR on a slip (D-26), a duplicate hint only. `off` turns it off; default on whenever the slip reading is on. */
    SLIP_QR: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).optional()),
    /**
     * The bank check of a slip by Slip2Go (D-27). Off by default; `slip2go` needs the secret key.
     * The key is a secret: it is never logged and never in an error message.
     */
    SLIP_VERIFIER: z.preprocess(emptyToUndefined, z.enum(['off', 'slip2go']).default('off')),
    SLIP2GO_BASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .url({ protocol: /^https$/, error: 'must be an https URL' })
        .default('https://connect.slip2go.com'),
    ),
    SLIP2GO_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    SLIP2GO_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1000).max(60_000).default(15_000),
    ),
    /** Calls to Slip2Go per business date; above it a slip is left to the staff tick. */
    SLIP2GO_DAILY_CAP: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(100_000).default(100),
    ),
    /** The server confirms a PromptPay payment itself on a valid bank check (D-27). Default off. */
    SLIP_AUTOCONFIRM: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).default('off')),
    /** Above this amount (satang) staff still confirm by hand. Default 1,000 THB. */
    SLIP_AUTOCONFIRM_MAX_SATANG: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(100_000_000).default(100_000),
    ),
    GIT_SHA: z.preprocess(emptyToUndefined, z.string().default('dev')),
  })
  .refine(
    (e) =>
      [e.R2_ACCOUNT_ID, e.R2_ACCESS_KEY_ID, e.R2_SECRET_ACCESS_KEY, e.R2_BUCKET].every(
        (v) => v === undefined,
      ) ||
      [e.R2_ACCOUNT_ID, e.R2_ACCESS_KEY_ID, e.R2_SECRET_ACCESS_KEY, e.R2_BUCKET].every(
        (v) => v !== undefined,
      ),
    {
      path: ['R2_BUCKET'],
      error: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET go together',
    },
  )
  .refine((e) => e.SLIP_VERIFIER !== 'slip2go' || e.SLIP2GO_SECRET_KEY !== undefined, {
    path: ['SLIP2GO_SECRET_KEY'],
    error: 'is required when SLIP_VERIFIER=slip2go',
  })
  .refine((e) => e.SLIP_AUTOCONFIRM !== 'on' || e.SLIP_VERIFIER === 'slip2go', {
    path: ['SLIP_AUTOCONFIRM'],
    error: 'needs SLIP_VERIFIER=slip2go',
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
  /** Directory of the slip image files (and, without R2, of the receipt photos in its `receipts` folder). */
  slipDir: string;
  /** Slips and receipts on Cloudflare R2 (D-36); null keeps them on disk. `secretAccessKey` is a secret. */
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } | null;
  /** The automatic slip reading (D-26); null when it is off. */
  slipOcr: { lang: string; timeoutMs: number } | null;
  /** The slip's small QR is read as well (D-26); only when the slip reading is on. */
  slipQr: boolean;
  /** The bank check by Slip2Go (D-27); null when it is off. `secretKey` is a secret: never log it. */
  slipVerifier: { baseUrl: string; secretKey: string; timeoutMs: number; dailyCap: number } | null;
  /** The server confirms a valid PromptPay slip itself (D-27); null when it is off. */
  slipAutoconfirm: { maxSatang: number } | null;
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
    r2:
      e.R2_ACCOUNT_ID !== undefined &&
      e.R2_ACCESS_KEY_ID !== undefined &&
      e.R2_SECRET_ACCESS_KEY !== undefined &&
      e.R2_BUCKET !== undefined
        ? {
            accountId: e.R2_ACCOUNT_ID,
            accessKeyId: e.R2_ACCESS_KEY_ID,
            secretAccessKey: e.R2_SECRET_ACCESS_KEY,
            bucket: e.R2_BUCKET,
          }
        : null,
    slipOcr:
      (e.SLIP_OCR ?? (e.NODE_ENV === 'production' ? 'tesseract' : 'off')) === 'tesseract'
        ? { lang: e.SLIP_OCR_LANG, timeoutMs: e.SLIP_OCR_TIMEOUT_MS }
        : null,
    slipQr: e.SLIP_QR !== 'off',
    slipVerifier:
      e.SLIP_VERIFIER === 'slip2go' && e.SLIP2GO_SECRET_KEY !== undefined
        ? {
            baseUrl: e.SLIP2GO_BASE_URL,
            secretKey: e.SLIP2GO_SECRET_KEY,
            timeoutMs: e.SLIP2GO_TIMEOUT_MS,
            dailyCap: e.SLIP2GO_DAILY_CAP,
          }
        : null,
    slipAutoconfirm:
      e.SLIP_AUTOCONFIRM === 'on' ? { maxSatang: e.SLIP_AUTOCONFIRM_MAX_SATANG } : null,
  };
}
