/**
 * Makes the VAPID key pair for phone alerts (Web Push, D-37) and writes it to a file as three
 * `.env` lines. Run by the owner, locally:
 *   pnpm --filter @sds/api push:keys [<file>] [--subject mailto:you@example.com] [--force]
 * The default file is apps/api/.env.vapid (git-ignored). Only the PUBLIC key and the file's path
 * are printed: the private key stays in the file. Copy the three lines into /opt/sds/.env on the
 * VM, then `./dc up -d --no-deps api`. The pair is permanent: a new one makes every device
 * subscribe again, so the command refuses to overwrite a file without --force.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PRIVACY, VAPID_SUBJECT_PATTERN } from '../config.ts';
import { writeVapidFile } from '../push/vapid-file.ts';
import { fail } from './common.ts';

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const subjectFlag = args.indexOf('--subject');
  const subject =
    subjectFlag >= 0 ? (args[subjectFlag + 1] ?? '') : `mailto:${DEFAULT_PRIVACY.contactEmail}`;
  if (!VAPID_SUBJECT_PATTERN.test(subject)) {
    fail('--subject must be a mailto: address or an https: URL.');
  }
  const valueIndex = subjectFlag >= 0 ? subjectFlag + 1 : -1;
  const file = args.find((a, i) => !a.startsWith('--') && i !== valueIndex);
  // From the repo root, or from apps/api (what `pnpm --filter` uses).
  const defaultFile = existsSync('apps/api') ? 'apps/api/.env.vapid' : '.env.vapid';
  const path = resolve(file ?? defaultFile);
  try {
    const result = writeVapidFile(path, subject, force);
    console.log(`Public key:  ${result.publicKey}`);
    console.log(`Key file:    ${result.path} (holds the private key; keep it out of git and chat)`);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      fail(
        `${path} already exists. A new key pair makes every device subscribe again; add --force to replace it.`,
      );
    }
    fail(`Could not write ${path}.`);
  }
}

main();
