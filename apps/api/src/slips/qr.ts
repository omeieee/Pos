import { Worker } from 'node:worker_threads';
import type { SlipQr } from '@sds/shared';

/**
 * Reads the small QR on a slip picture (D-26): the sending bank and the transaction reference, as
 * a duplicate key for staff. Only the shop's own server does it, in a worker thread, so a slip
 * never goes to a cloud service and a slow decode cannot stop the API. The raw QR text is never
 * returned, stored or logged.
 */
export interface SlipQrReader {
  /** The parsed QR, or null when the picture has none (or it cannot be read). Rejects on failure or timeout. */
  read(image: Buffer): Promise<SlipQr | null>;
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
): SlipQrReader {
  const timeoutMs = options.timeoutMs ?? HARD_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  return {
    read(image) {
      return new Promise<SlipQr | null>((resolve, reject) => {
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
        worker.once('message', (answer: SlipQr | null) => finish(() => resolve(answer)));
        worker.once('error', () => finish(() => reject(new Error('QR_FAILED'))));
        worker.once('exit', () => finish(() => reject(new Error('QR_FAILED'))));
      });
    },
  };
}
