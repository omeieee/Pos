/**
 * The agent loop: owed acks -> claim -> render -> send to the printer -> ack.
 *
 * - A job is only ever printed once per id on this notebook (`PrintedStore`), even when the server
 *   offers it again after a lost ack.
 * - A failed print is acked `failed` with a code from the shared list; the server retries it.
 * - When the API cannot be reached the loop backs off (2 s, doubling, up to 60 s) and never stops.
 * - Stopping waits for the job in hand: every step has a timeout, so it ends within seconds, and the
 *   ack is sent before the loop exits.
 */
import { renderTicket } from '@sds/escpos';
import type { ClaimedPrintJob, KitchenTicket, PrintErrorCode } from '@sds/shared';
import { ApiCallError, type PrintApi } from './api.ts';
import type { AgentConfig } from './config.ts';
import type { Logger } from './log.ts';
import { PrinterError, type SendToPrinter } from './printer.ts';
import type { PrintedStore } from './store.ts';

export interface AgentDeps {
  config: AgentConfig;
  api: PrintApi;
  store: PrintedStore;
  log: Logger;
  send: SendToPrinter;
  render?: (ticket: KitchenTicket) => Uint8Array;
  /** Waits `ms`, or less when the agent is stopping. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export type RunResult = 'printed' | 'failed' | 'duplicate' | 'idle';

export const BACKOFF_START_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;

/** The wait after `failures` unreachable answers in a row (before jitter). */
export const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

export function createAgent(deps: AgentDeps) {
  const { config, api, store, log, send } = deps;
  const render =
    deps.render ??
    ((ticket: KitchenTicket) => renderTicket(ticket, { widthDots: config.printer.widthDots }));
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;
  const stopper = new AbortController();

  /** Delivers "printed" acks that could not be delivered earlier. Throws if the API is unreachable. */
  async function deliverOwedAcks(): Promise<void> {
    for (const entry of store.owed()) {
      try {
        await api.ack(entry.id, { leaseToken: entry.leaseToken, result: 'printed' });
        store.markAcked(entry.id);
        log('info', 'ack.delivered', { jobId: entry.id, status: 'printed' });
      } catch (error) {
        // The job is gone or was settled elsewhere: nothing more to tell the server.
        if (error instanceof ApiCallError && error.kind === 'rejected') {
          store.markAcked(entry.id);
          log('warn', 'ack.dropped', { jobId: entry.id, httpStatus: error.status });
          continue;
        }
        throw error;
      }
    }
  }

  async function ackFailed(job: ClaimedPrintJob, errorCode: PrintErrorCode): Promise<void> {
    try {
      await api.ack(job.id, { leaseToken: job.leaseToken, result: 'failed', errorCode });
    } catch (error) {
      // The lease runs out and the server offers the job again; nothing is lost by waiting.
      if (!(error instanceof ApiCallError)) throw error;
      log('warn', 'ack.failed_not_delivered', { jobId: job.id, reason: error.kind });
    }
  }

  async function handleJob(job: ClaimedPrintJob): Promise<RunResult> {
    log('info', 'job.claimed', {
      jobId: job.id,
      kind: job.kind,
      seq: job.seq,
      attempt: job.attempt,
    });

    if (store.has(job.id)) {
      // Printed before; only the ack was lost. Do not print again.
      store.recordPrinted(job.id, job.leaseToken);
      log('warn', 'job.duplicate_skipped', { jobId: job.id });
      await deliverOwedAcks();
      return 'duplicate';
    }

    let bytes: Uint8Array;
    try {
      bytes = render(job.ticket);
    } catch {
      log('error', 'job.render_failed', { jobId: job.id });
      await ackFailed(job, 'RENDER_FAILED');
      return 'failed';
    }

    try {
      await send(bytes, config.printer);
    } catch (error) {
      const code: PrintErrorCode = error instanceof PrinterError ? error.code : 'OTHER';
      log('warn', 'job.print_failed', { jobId: job.id, errorCode: code });
      await ackFailed(job, code);
      return 'failed';
    }

    store.recordPrinted(job.id, job.leaseToken);
    log('info', 'job.printed', { jobId: job.id });
    try {
      await deliverOwedAcks();
    } catch (error) {
      // Printed, ack owed: the entry stays in the store and is retried on the next round.
      if (!(error instanceof ApiCallError)) throw error;
      log('warn', 'ack.pending', { jobId: job.id, reason: error.kind });
    }
    return 'printed';
  }

  /** One round: settle owed acks, ask for a job, handle it. Throws `ApiCallError` when the API fails. */
  async function runOnce(): Promise<RunResult> {
    await deliverOwedAcks();
    const job = await api.claim();
    if (!job) return 'idle';
    return handleJob(job);
  }

  async function run(): Promise<void> {
    let failures = 0;
    let lastFailure: string | null = null;
    log('info', 'agent.started', { pollMs: config.pollIntervalMs });
    while (!stopper.signal.aborted) {
      try {
        const result = await runOnce();
        if (lastFailure !== null) log('info', 'api.recovered');
        failures = 0;
        lastFailure = null;
        // A busy queue is drained without pausing; an empty one is polled gently.
        if (result === 'idle') await sleep(config.pollIntervalMs, stopper.signal);
      } catch (error) {
        failures += 1;
        const reason = error instanceof ApiCallError ? error.kind : 'unexpected';
        const delay =
          error instanceof ApiCallError && error.kind === 'auth'
            ? BACKOFF_MAX_MS
            : Math.round(backoffMs(failures) * (0.8 + random() * 0.4));
        // Say it when it starts and when the reason changes, then stay quiet but keep trying.
        if (reason !== lastFailure) {
          log('error', 'api.unavailable', {
            reason,
            httpStatus: error instanceof ApiCallError ? error.status : null,
            retryInMs: delay,
          });
        }
        lastFailure = reason;
        await sleep(delay, stopper.signal);
      }
    }
    log('info', 'agent.stopped');
  }

  return {
    run,
    runOnce,
    /** Asks the loop to end after the job in hand. */
    stop: () => stopper.abort(),
  };
}
