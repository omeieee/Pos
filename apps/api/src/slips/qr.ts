import { Worker } from 'node:worker_threads';
import type { SlipQr } from '@sds/shared';
import type { SlipQrText } from './qr-decode.ts';

/**
 * Reads the small QR on a slip picture (D-26): the sending bank and the transaction reference, as
 * a duplicate key for staff. Only the shop's own server does it, in a worker thread, so a slow
 * decode cannot stop the API. `readRaw` also hands back the raw QR text (D-27) so that the bank
 * check can be sent the text instead of the picture; that text is for memory only: never stored,
 * logged or put in an answer.
 */
export interface SlipQrReader {
  /** The parsed QR, or null when the picture has none (or it cannot be read). Rejects on failure or timeout. */
  read(image: Buffer): Promise<SlipQr | null>;
  /** Like `read`, with the raw text of the QR as well. Without it the checker falls back to `read`. */
  readRaw?(image: Buffer): Promise<SlipQrText | null>;
}

/** The decoder checks its own budget between tries; this is the hard stop on top of it. */
const BUDGET_MS = 15_000;
const HARD_TIMEOUT_MS = 20_000;

/** The worker file: the TypeScript source when running from source (tests), the bundle's entry otherwise. */
const workerUrl = () =>
  new URL(
    import.meta.url.endsWith('.ts') ? './qr-worker.ts' : './slip-qr-worker.js',
    import.meta.url,
  );

export function createWorkerQrReader(
  options: { timeoutMs?: number; budgetMs?: number } = {},
): Required<SlipQrReader> {
  const timeoutMs = options.timeoutMs ?? HARD_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const run = (image: Buffer) =>
    new Promise<SlipQrText | null>((resolve, reject) => {
      const worker = new Worker(workerUrl(), {
        workerData: { bytes: image, budgetMs },
        // The heap of the worker only; the decoded pixels are outside it, and the API checks
        // the picture's size before it gets here.
        resourceLimits: { maxOldGenerationSizeMb: 160 },
      });
      let settled = false;
      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        done();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('QR_TIMEOUT'))), timeoutMs);
      worker.once('message', (answer: SlipQrText | null) => finish(() => resolve(answer)));
      worker.once('error', () => finish(() => reject(new Error('QR_FAILED'))));
      worker.once('exit', () => finish(() => reject(new Error('QR_FAILED'))));
    });
  return {
    read: async (image) => (await run(image))?.qr ?? null,
    readRaw: run,
  };
}
