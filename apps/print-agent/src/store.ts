/**
 * What the agent has already printed, kept in a small JSON file. The queue is at-least-once: if the
 * printer got the ticket but the "printed" ack never reached the server, the job is offered again;
 * the agent finds its id here and acks without printing a second ticket.
 *
 * An entry also remembers an ack that is still owed (`acked: false`), so it survives a restart.
 * Only ids and lease tokens are stored: never ticket text.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const entrySchema = z.object({
  id: z.uuid(),
  leaseToken: z.uuid(),
  printedAt: z.iso.datetime(),
  acked: z.boolean(),
});
export type PrintedEntry = z.infer<typeof entrySchema>;

const fileSchema = z.object({ version: z.literal(1), jobs: z.array(entrySchema) });

/** Acked entries are kept this long (a lost ack can only come back within minutes). */
const KEEP_ACKED_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2_000;

export interface PrintedStore {
  has(jobId: string): boolean;
  /** Printed, ack still owed. */
  recordPrinted(jobId: string, leaseToken: string): void;
  markAcked(jobId: string): void;
  /** Entries whose "printed" ack has not been delivered. */
  owed(): PrintedEntry[];
}

export function openPrintedStore(
  file: string,
  options: { now?: () => Date; onProblem?: (event: 'unreadable' | 'unwritable') => void } = {},
): PrintedStore {
  const now = options.now ?? (() => new Date());
  let entries: PrintedEntry[] = [];

  if (existsSync(file)) {
    try {
      entries = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).jobs;
    } catch {
      // A damaged file must not stop printing; start again and say so.
      options.onProblem?.('unreadable');
    }
  }

  const save = () => {
    const cutoff = now().getTime() - KEEP_ACKED_MS;
    entries = entries
      .filter((entry) => !entry.acked || new Date(entry.printedAt).getTime() >= cutoff)
      .slice(-MAX_ENTRIES);
    try {
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, jobs: entries }));
      renameSync(temp, file); // replace in one step so a crash never leaves half a file
    } catch {
      options.onProblem?.('unwritable');
    }
  };

  return {
    has: (jobId) => entries.some((entry) => entry.id === jobId),
    recordPrinted(jobId, leaseToken) {
      const existing = entries.find((entry) => entry.id === jobId);
      if (existing) {
        existing.leaseToken = leaseToken;
        existing.acked = false;
      } else {
        entries.push({ id: jobId, leaseToken, printedAt: now().toISOString(), acked: false });
      }
      save();
    },
    markAcked(jobId) {
      const existing = entries.find((entry) => entry.id === jobId);
      if (existing && !existing.acked) {
        existing.acked = true;
        save();
      }
    },
    owed: () => entries.filter((entry) => !entry.acked).map((entry) => ({ ...entry })),
  };
}
