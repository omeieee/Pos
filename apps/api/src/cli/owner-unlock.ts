/**
 * Clears the owner's sign-in lock and failed-attempt count, for the case where wrong attempts
 * (or someone else's) locked the owner out. Types no secret. See ./common.ts for how to run it.
 */
import { createDb } from '@sds/db';
import { NoOwnerError, unlockOwner } from '../auth/owner-admin.ts';
import { describeError, fail, loadCliEnv } from './common.ts';

async function main() {
  const env = loadCliEnv({ needsKey: false });
  const { db, close } = createDb(env.databaseUrl, { max: 1 });
  try {
    await unlockOwner({ db });
    console.log('The owner account is unlocked.');
  } catch (error) {
    if (error instanceof NoOwnerError) fail('No owner exists. Run owner:create first.');
    fail(`Could not unlock the owner: ${describeError(error)}`);
  } finally {
    await close();
  }
}

await main();
