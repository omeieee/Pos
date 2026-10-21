/**
 * Copies the slip files in SLIP_DIR to Cloudflare R2, key for key (D-36). Run by hand on the VM,
 * after the R2_* variables are in /opt/sds/.env, like the owner:* commands:
 *   cd /opt/sds && ./dc run --rm --no-deps api node dist/slips-to-r2.js            # dry run
 *   cd /opt/sds && ./dc run --rm --no-deps api node dist/slips-to-r2.js --apply    # copy
 * Safe to repeat. Run it again after switching the API to R2 to catch slips uploaded in between.
 * It only reads the disk: the files stay until the owner removes them. Prints counts only.
 */
import { loadConfig } from '../config.ts';
import { copySlipsToTarget } from '../slips/copy-to-r2.ts';
import { createR2SlipStore, R2_SLIP_PREFIX } from '../slips/r2-store.ts';
import { createFsSlipStore } from '../slips/store.ts';
import { fail } from './common.ts';

async function main() {
  const config = loadConfig();
  if (!config.r2) {
    fail('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are not set.');
  }
  const apply = process.argv.includes('--apply');
  const report = await copySlipsToTarget({
    source: createFsSlipStore(config.slipDir),
    target: createR2SlipStore({ ...config.r2, prefix: R2_SLIP_PREFIX }),
    apply,
  });
  console.log(JSON.stringify(report));
  if (!apply) console.log('Dry run: nothing was written. Add --apply to copy.');
  if (report.failed > 0 || report.mismatched > 0) process.exit(2);
}

main().catch((error) => {
  // The error class only: a message could carry a host or a path.
  fail(`The copy stopped: ${error instanceof Error ? error.name : 'Error'}.`);
});
