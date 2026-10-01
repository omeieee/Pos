/**
 * Re-enrols the owner's authenticator and issues new recovery codes. For a lost phone, or a lost
 * or changed AUTH_SECRET_KEY (the stored secret no longer decrypts). Needs a terminal, and the
 * owner's password or one valid recovery code as proof. Refuses when no owner exists. Ends every
 * open owner session. See ./common.ts for how to run it.
 */
import { authRepo, createDb } from '@sds/db';
import { deriveAuthKeys } from '../auth/crypto.ts';
import { NoOwnerError, resetOwnerSecondFactor, verifyOwnerProof } from '../auth/owner-admin.ts';
import {
  createPrompter,
  describeError,
  enrolAuthenticator,
  fail,
  loadCliEnv,
  printRecoveryCodes,
  requireTerminal,
} from './common.ts';

const MAX_PROOF_TRIES = 3;

async function main() {
  const env = loadCliEnv({ needsKey: true });
  requireTerminal();

  const keys = deriveAuthKeys(env.authKey as Buffer);
  const { db, close } = createDb(env.databaseUrl, { max: 1 });
  const prompt = createPrompter();
  try {
    const owner = await db.transaction((tx) => authRepo.lockSoleOwner(tx));
    if (!owner) throw new NoOwnerError();

    console.log(`Resetting the authenticator and recovery codes for ${owner.email}.`);
    console.log('Every open owner session will end, and the old codes stop working.\n');

    // Authenticate first, then enrol, so a wrong guess costs nothing and a half-done reset
    // never leaves the account without a working second factor.
    let proof: string | undefined;
    for (let tries = 0; tries < MAX_PROOF_TRIES && proof === undefined; tries++) {
      const typed = await prompt.askHidden('Owner password, or one recovery code (not shown): ');
      if (await verifyOwnerProof({ db }, typed)) proof = typed;
      else console.error('That is not the owner password or a valid recovery code.');
    }
    if (proof === undefined) fail('Too many wrong tries. Nothing was changed.');

    const newTotpSecret = await enrolAuthenticator(prompt, owner.email);
    const result = await resetOwnerSecondFactor(
      { db, keys, now: () => new Date() },
      { proof, newTotpSecret },
    );
    if (!result.ok)
      fail('The proof no longer works (a recovery code can be used once). Nothing was changed.');
    console.log('\nDone. The new authenticator is active.');
    printRecoveryCodes(result.recoveryCodes);
  } catch (error) {
    if (error instanceof NoOwnerError) fail('No owner exists. Run owner:create first.');
    fail(`Could not reset the owner: ${describeError(error)}`);
  } finally {
    prompt.close();
    await close();
  }
}

await main();
