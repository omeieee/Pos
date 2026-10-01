/**
 * Creates the first owner. Interactive, so it needs a terminal:
 *   local:  DATABASE_URL=... AUTH_SECRET_KEY=... pnpm --filter @sds/api owner:create
 *   VM:     docker run --rm -it --env-file /opt/sds/.env <api image> node dist/owner-create.js
 *
 * Secrets are never taken from argv or from the environment except the two settings above,
 * and never read from a file in the repo. The password and PIN are typed without echo. The
 * one-time recovery codes and the authenticator secret are printed once, to the terminal only.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { authRepo, createDb } from '@sds/db';
import { ownerPasswordSchema, pinSchema } from '@sds/shared';
import { deriveAuthKeys } from '../auth/crypto.ts';
import { createOwner, OwnerExistsError } from '../auth/owner-setup.ts';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import { authSecretKeySchema, databaseUrlSchema } from '../config.ts';
import { redactQueryParams } from '../redact.ts';

const ISSUER = 'Saap Don Sen POS';
const MAX_CODE_TRIES = 3;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function createPrompter() {
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

async function askUntilValid<T>(
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

async function main() {
  const url = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  const key = authSecretKeySchema.safeParse(process.env.AUTH_SECRET_KEY);
  if (!url.success) fail(`DATABASE_URL: ${url.error.issues[0]?.message ?? 'invalid'}`);
  if (!key.success) fail(`AUTH_SECRET_KEY: ${key.error.issues[0]?.message ?? 'invalid'}`);
  if (!process.stdin.isTTY) {
    fail('This command types secrets, so it needs a terminal (docker run -it ...).');
  }

  const keys = deriveAuthKeys(key.data);
  const { db, close } = createDb(url.data, { max: 1 });
  const prompt = createPrompter();
  try {
    // Refuse early; createOwner checks again inside its transaction.
    if (await authRepo.ownerExists(db)) throw new OwnerExistsError();
    const email = await askUntilValid(
      () => prompt.ask('Owner e-mail: '),
      (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined),
      'That does not look like an e-mail address.',
    );
    const displayName = await askUntilValid(
      () => prompt.ask('Name shown in the app: '),
      (v) => (v.length >= 1 && v.length <= 60 ? v : undefined),
      'Use 1 to 60 characters.',
    );
    const password = await askUntilValid(
      async () => {
        const first = await prompt.askHidden('Password (12+ characters, not shown): ');
        const second = await prompt.askHidden('Repeat the password: ');
        return first === second ? first : '';
      },
      (v) => (ownerPasswordSchema.safeParse(v).success ? v : undefined),
      'The passwords differ, or are shorter than 12 characters. Try again.',
    );
    let pin: string | undefined;
    for (;;) {
      const answer = await prompt.askHidden(
        'Daily PIN for your own devices (4-6 digits, empty to skip): ',
      );
      if (answer === '') break;
      if (pinSchema.safeParse(answer).success) {
        pin = answer;
        break;
      }
      console.error('Use 4 to 6 digits, or leave it empty.');
    }

    // Enrol the authenticator before saving anything: no owner is created that cannot sign in.
    const totpSecret = generateTotpSecret();
    console.log('\nAdd the account to an authenticator app (any RFC 6238 app).');
    console.log('This is shown once and is not stored in clear.');
    console.log(`  Secret (type it in): ${base32Encode(totpSecret)}`);
    console.log(
      `  Or the otpauth URI:  ${otpauthUri({ secret: totpSecret, account: email, issuer: ISSUER })}\n`,
    );

    let confirmed = false;
    for (let tries = 0; tries < MAX_CODE_TRIES && !confirmed; tries++) {
      const code = await prompt.ask('Enter the 6-digit code now shown in the app: ');
      confirmed = verifyTotp(totpSecret, code, Date.now()).ok;
      if (!confirmed) console.error('That code is not right.');
    }
    if (!confirmed) fail('The code was not confirmed. Nothing was saved. Run the command again.');

    const { recoveryCodes } = await createOwner(
      { db, keys },
      { email, displayName, password, pin, totpSecret },
    );
    console.log('\nOwner created. RECOVERY CODES (shown once, each works one time):');
    for (const code of recoveryCodes) console.log(`  ${code}`);
    console.log(
      '\nWrite them on paper and keep them with the age backup key. They cannot be shown again.',
    );
  } catch (error) {
    if (error instanceof OwnerExistsError) fail('An owner already exists. Nothing was changed.');
    // Messages only: no query parameters, no connection string.
    const message = error instanceof Error ? redactQueryParams(error.message) : 'unknown error';
    fail(`Could not create the owner: ${message}`);
  } finally {
    prompt.close();
    await close();
  }
}

await main();
