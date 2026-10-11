import { parentPort, workerData } from 'node:worker_threads';
import { readSlipQrText } from './qr-decode.ts';

/**
 * Runs in a worker thread: reads the slip QR of ONE picture and answers with the parsed result and
 * its raw text (or null). The text goes to the caller in memory only. See `qr.ts`.
 */
const { bytes, budgetMs } = workerData as { bytes: Uint8Array; budgetMs: number };
parentPort?.postMessage(readSlipQrText(bytes, budgetMs));
