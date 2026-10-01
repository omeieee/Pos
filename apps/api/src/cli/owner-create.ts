/**
 * Creates the first owner. Interactive, so it needs a terminal (see ./common.ts for how to run
 * it locally and on the VM). The authenticator is enrolled and confirmed before anything is saved.
 */
import { authRepo, createDb } from '@sds/db';
import { ownerPasswordSchema, pinSchemaFor } from '@sds/shared';
import { deriveAuthKeys } from '../auth/crypto.ts';
import { createOwner, OwnerExistsError } from '../auth/owner-setup.ts';
import {
  askUntilValid,
  createPrompter,
  describeError,
  enrolAuthenticator,
  fail,
  loadCliEnv,
  printRecoveryCodes,
  requireTerminal,
} from './common.ts';

async function main() {
  const env = loadCliEnv({ needsKey: true });
  requireTerminal();

  const keys = deriveAuthKeys(env.authKey as Buffer);
  const { db, close } = createDb(env.databaseUrl, { max: 1 });
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
        'Daily PIN for your own devices (6 digits, empty to skip): ',
      );
      if (answer === '') break;
      if (pinSchemaFor('owner').safeParse(answer).success) {
        pin = answer;
        break;
      }
      console.error('The owner PIN is 6 digits, or leave it empty.');
    }

    const totpSecret = await enrolAuthenticator(prompt, email);
    const { recoveryCodes } = await createOwner(
      { db, keys },
      { email, displayName, password, pin, totpSecret },
    );
    console.log('\nOwner created.');
    printRecoveryCodes(recoveryCodes);
  } catch (error) {
    if (error instanceof OwnerExistsError) fail('An owner already exists. Nothing was changed.');
    fail(`Could not create the owner: ${describeError(error)}`);
  } finally {
    prompt.close();
    await close();
  }
}

await main();
