/**
 * Shared parts of the owner:* commands. They are run by hand in a terminal on the VM:
 *   cd /opt/sds && ./dc run --rm --no-deps -e NODE_OPTIONS=--max-old-space-size=384 \
 *     api node dist/<command>.js
 * (through compose, which reads /opt/sds/.env and strips its quotes; a plain
 * `docker run --env-file` would keep the quotes and fail the checks in loadCliEnv).
 * Locally: DATABASE_URL=... AUTH_SECRET_KEY=... pnpm --filter @sds/api owner:<command>.
 *
 * Secrets are never taken from argv, and never read from a file in the repo. Passwords and PINs
 * are typed without echo. Recovery codes and the authenticator secret are printed once, to the
 * terminal only.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import { authSecretKeySchema, databaseUrlSchema } from '../config.ts';
import { redactQueryParams } from '../redact.ts';

const ISSUER = 'Saap Don Sen POS';
const MAX_CODE_TRIES = 3;

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** DATABASE_URL (and AUTH_SECRET_KEY when the command needs it), validated; exits on a problem. */
export function loadCliEnv(options: { needsKey: boolean }) {
  const url = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!url.success) fail(`DATABASE_URL: ${url.error.issues[0]?.message ?? 'invalid'}`);
  let authKey: Buffer | undefined;
  if (options.needsKey) {
    const key = authSecretKeySchema.safeParse(process.env.AUTH_SECRET_KEY);
    if (!key.success) fail(`AUTH_SECRET_KEY: ${key.error.issues[0]?.message ?? 'invalid'}`);
    authKey = key.data;
  }
  return { databaseUrl: url.data, authKey };
}

/**
 * `--email <address>` (or `--email=<address>`): which owner a command is about, needed once there
 * is more than one owner. Undefined when absent; exits on a flag with no value.
 */
export function emailArg(argv: readonly string[] = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg !== '--email' && !arg.startsWith('--email=')) continue;
    const value = arg === '--email' ? argv[i + 1] : arg.slice('--email='.length);
    if (!value || value.startsWith('--')) {
      fail('--email needs an address, e.g. --email owner@example.com');
    }
    return value;
  }
  return undefined;
}

/** What to say when several owners exist and no --email was given: the count only, no addresses. */
export function multipleOwnersMessage(count: number): string {
  return `There are ${count} owners. Run the command again with --email <the owner's address>.`;
}

export function requireTerminal(): void {
  if (!process.stdin.isTTY) {
    fail('This command types secrets, so it needs a terminal (run it in an interactive shell).');
  }
}

export function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return {
    async ask(question: string): Promise<string> {
      muted = false;
      return (await rl.question(question)).trim();
    },
    /** Typed characters are not echoed. */
    async askHidden(question: string): Promise<string> {
      process.stdout.write(question);
      muted = true;
      const answer = await rl.question('');
      muted = false;
      process.stdout.write('\n');
      return answer;
    },
    close: () => rl.close(),
  };
}

export type Prompter = ReturnType<typeof createPrompter>;

export async function askUntilValid<T>(
  read: () => Promise<string>,
  check: (value: string) => T | undefined,
  hint: string,
): Promise<T> {
  for (;;) {
    const value = check(await read());
    if (value !== undefined) return value;
    console.error(hint);
  }
}

/**
 * Shows a new TOTP secret and makes the person type a code from their app before anything is
 * saved, so no account is created or changed into one that cannot sign in. Exits if not confirmed.
 */
export async function enrolAuthenticator(prompt: Prompter, account: string): Promise<Buffer> {
  const secret = generateTotpSecret();
  console.log('\nAdd the account to an authenticator app (any RFC 6238 app).');
  console.log('This is shown once and is not stored in clear.');
  console.log(`  Secret (type it in): ${base32Encode(secret)}`);
  console.log(`  Or the otpauth URI:  ${otpauthUri({ secret, account, issuer: ISSUER })}\n`);

  for (let tries = 0; tries < MAX_CODE_TRIES; tries++) {
    const code = await prompt.ask('Enter the 6-digit code now shown in the app: ');
    if (verifyTotp(secret, code, Date.now()).ok) return secret;
    console.error('That code is not right.');
  }
  return fail('The code was not confirmed. Nothing was saved. Run the command again.');
}

export function printRecoveryCodes(codes: readonly string[]): void {
  console.log('RECOVERY CODES (shown once, each works one time):');
  for (const code of codes) console.log(`  ${code}`);
  console.log(
    '\nWrite them on paper and keep them with the age backup key. They cannot be shown again.',
  );
}

/** Messages only: no query parameters, no connection string. */
export function describeError(error: unknown): string {
  return error instanceof Error ? redactQueryParams(error.message) : 'unknown error';
}
