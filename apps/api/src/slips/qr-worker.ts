import { parentPort, workerData } from 'node:worker_threads';
import { readSlipQr } from './qr-decode.ts';

/**
 * Runs in a worker thread: reads the slip QR of ONE picture and answers with the parsed result (or
 * null). The raw QR text never leaves `readSlipQr`. See `qr.ts`.
 */
const { bytes, budgetMs } = workerData as { bytes: Uint8Array; budgetMs: number };
parentPort?.postMessage(readSlipQr(bytes, budgetMs));
