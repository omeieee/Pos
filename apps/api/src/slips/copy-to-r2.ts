import { createHash } from 'node:crypto';
import type { SlipStore } from './store.ts';

export interface CopyReport {
  apply: boolean;
  /** Files in the source. */
  found: number;
  /** Already in the target with the same size: left alone. */
  alreadyThere: number;
  copied: number;
  /** Dry run only: what `--apply` would copy. */
  wouldCopy: number;
  /** Written, but the read-back differs in size or SHA-256. The target copy is left for a rerun to replace. */
  mismatched: number;
  failed: number;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * The one-off move of slip files from disk to R2 (D-36), key for key. Safe to run any number of
 * times: a file already in the target with the same size is skipped, so a second run after the
 * switch also picks up slips uploaded in between. Every copy is read back and compared by size
 * and SHA-256. The source is only ever read, never deleted. `apply` is off unless asked for.
 * Reports counts only (no keys: a key opens a customer's slip).
 */
export async function copySlipsToTarget(args: {
  source: SlipStore;
  target: SlipStore;
  apply?: boolean;
}): Promise<CopyReport> {
  const report: CopyReport = {
    apply: args.apply === true,
    found: 0,
    alreadyThere: 0,
    copied: 0,
    wouldCopy: 0,
    mismatched: 0,
    failed: 0,
  };
  const present = new Map((await args.target.list()).map((file) => [file.key, file.size]));
  for (const file of await args.source.list()) {
    report.found += 1;
    if (present.get(file.key) === file.size) {
      report.alreadyThere += 1;
      continue;
    }
    if (!report.apply) {
      report.wouldCopy += 1;
      continue;
    }
    try {
      const bytes = await args.source.get(file.key);
      if (!bytes) {
        report.failed += 1; // vanished since the listing (the 90-day job deleted it)
        continue;
      }
      await args.target.put(file.key, bytes);
      const back = await args.target.get(file.key);
      if (!back || back.length !== bytes.length || sha256(back) !== sha256(bytes)) {
        report.mismatched += 1;
        continue;
      }
      report.copied += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
