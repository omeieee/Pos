import { securityAlert } from '../auth/service.ts';
import type { SlipStore } from '../slips/store.ts';
import type { JobDeps } from './jobs.ts';

/**
 * The Cloudflare R2 free quota for Standard storage (D-36): 10 GB-month (decimal gigabytes, as R2
 * counts them). The standing rule is zero Cloudflare fees, so the owner is told well before it.
 */
export const R2_FREE_BYTES = 10_000_000_000;
export const STORAGE_WARN_RATIO = 0.7;

async function measure(store: SlipStore | undefined) {
  let files = 0;
  let bytes = 0;
  if (store) {
    for (const file of await store.list()) {
      files += 1;
      bytes += file.size;
    }
  }
  return { files, bytes };
}

/**
 * The nightly look at what the slip and receipt stores hold. It lists both (one Class A operation
 * per 1000 files on R2) and sends the owner a `warn` alert, with no figures in it, when the total
 * passes 70% of the free quota. Only the stored bytes are known here: the S3 API cannot report
 * the monthly count of Class A or B operations, so that one stays a Cloudflare dashboard check.
 * Counts only; a store that cannot be listed fails the run (the next night tries again).
 */
export async function checkStorageUsage(deps: JobDeps): Promise<Record<string, number>> {
  const slips = await measure(deps.slips);
  const receipts = await measure(deps.receipts);
  const usedBytes = slips.bytes + receipts.bytes;
  const usedPercent = Math.round((usedBytes / R2_FREE_BYTES) * 1000) / 10;
  let alerts = 0;
  if (usedBytes > R2_FREE_BYTES * STORAGE_WARN_RATIO) {
    deps.events.publish(securityAlert({ now: deps.now }, 'storage.quota_high', 'warn', {}));
    alerts = 1;
  }
  return {
    slipFiles: slips.files,
    receiptFiles: receipts.files,
    usedBytes,
    usedPercent,
    alerts,
  };
}
