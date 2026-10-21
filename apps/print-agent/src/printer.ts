/**
 * Raw ESC/POS over TCP to the printer (default port 9100): no Windows driver, nothing installed.
 * A job counts as sent when every byte has been handed to the network and our side closed
 * cleanly. A TCP success does not prove paper came out (a printer can be out of paper while its
 * network card still answers); the optional status check narrows that gap.
 */
import { connect, type Socket } from 'node:net';
import {
  concatBytes,
  isCoverOpenStatus,
  isOfflineStatus,
  isPaperEndStatus,
  statusQuery,
} from '@sds/escpos';
import type { PrintErrorCode } from '@sds/shared';

export class PrinterError extends Error {
  readonly code: PrintErrorCode;
  constructor(code: PrintErrorCode) {
    super(`Printer error: ${code}`);
    this.name = 'PrinterError';
    this.code = code;
  }
}

export interface PrinterTarget {
  host: string;
  port: number;
  timeoutMs: number;
  statusCheck: boolean;
}

export type SendToPrinter = (bytes: Uint8Array, target: PrinterTarget) => Promise<void>;

const OFFLINE_ERRORS = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'ECONNRESET',
  'EPIPE',
]);

const socketErrorCode = (error: NodeJS.ErrnoException): PrintErrorCode => {
  if (error.code && OFFLINE_ERRORS.has(error.code)) return 'PRINTER_OFFLINE';
  if (error.code === 'ETIMEDOUT') return 'TIMEOUT';
  return 'OTHER';
};

/** How long to wait for the printer to close its side after we are done, before closing for it. */
const CLOSE_GRACE_MS = 1_500;
const STATUS_WAIT_MS = 800;

/** Asks the three status questions; null means all clear or no (usable) answer. */
function readProblem(socket: Socket): Promise<PrintErrorCode | null> {
  return new Promise((resolve) => {
    const replies: number[] = [];
    const done = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      if (replies.length < 3) return resolve(null);
      const [printer, cause, paper] = replies as [number, number, number];
      if (isPaperEndStatus(paper)) return resolve('OUT_OF_PAPER');
      if (isOfflineStatus(printer))
        return resolve(isCoverOpenStatus(cause) ? 'COVER_OPEN' : 'PRINTER_OFFLINE');
      resolve(null);
    };
    const onData = (chunk: Buffer) => {
      replies.push(...chunk);
      if (replies.length >= 3) done();
    };
    const timer = setTimeout(done, STATUS_WAIT_MS);
    socket.on('data', onData);
    socket.write(concatBytes([statusQuery(1), statusQuery(2), statusQuery(4)]));
  });
}

export const sendToPrinter: SendToPrinter = (bytes, target) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    let settled = false;
    let flushed = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (error?: PrinterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(graceTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const overall = setTimeout(() => settle(new PrinterError('TIMEOUT')), target.timeoutMs);

    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(new PrinterError(socketErrorCode(error))),
    );
    socket.on('close', () => settle(flushed ? undefined : new PrinterError('PRINTER_OFFLINE')));
    socket.once('finish', () => {
      flushed = true;
      graceTimer = setTimeout(() => settle(), CLOSE_GRACE_MS);
    });
    socket.once('connect', () => {
      void (async () => {
        if (target.statusCheck) {
          const problem = await readProblem(socket);
          if (problem) return settle(new PrinterError(problem));
        }
        socket.end(bytes);
      })();
    });
  });
