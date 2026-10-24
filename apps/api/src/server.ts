import { createDb, pingDb, pingFreshDb } from '@sds/db';
import { SLIP_FIRST_CALL_DELAY_BY_BANK_MS, SLIP_FIRST_CALL_DELAY_MS } from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type AlertReport, forwardAlerts } from './alerts.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createEventBus } from './events.ts';
import { startJobs } from './jobs/boss.ts';
import { alertOnAttempt, superviseJobs } from './jobs/supervisor.ts';
import { createLineRuntime } from './line/runtime.ts';
import { createPoolWatchdog } from './pool-watchdog.ts';
import { sentryOptions } from './redact.ts';
import { createSlipChecker, installSlipChecker, installSlipQrReader } from './slips/checker.ts';
import { createTesseractOcr } from './slips/ocr.ts';
import { createWorkerQrReader } from './slips/qr.ts';
import { createR2SlipStore, R2_RECEIPT_PREFIX, R2_SLIP_PREFIX } from './slips/r2-store.ts';
import { createSlip2goVerifier, installSlipVerifier } from './slips/slip2go.ts';
import { createFsSlipStore } from './slips/store.ts';
import { registerV1 } from './v1.ts';

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();

let setup: ((app: FastifyInstance) => void) | undefined;
let reportAlert: ((report: AlertReport) => void) | undefined;
if (config.sentryDsn) {
  // Loaded only when configured. Inside the bundle Sentry reports errors but cannot
  // auto-instrument libraries (that needs `--import` before the app loads).
  const Sentry = await import('@sentry/node');
  Sentry.init(
    sentryOptions({ dsn: config.sentryDsn, environment: config.nodeEnv, release: config.version }),
  );
  setup = (app) => Sentry.setupFastifyErrorHandler(app);
  reportAlert = (r) =>
    Sentry.captureMessage(r.message, { level: r.level, tags: r.tags, extra: r.extra });
}

// postgres-js connects lazily: the server starts, and /healthz answers, even while the DB is down.
const { db, close } = createDb(config.databaseUrl);

const app = await buildApp({
  config,
  checkDb: () => pingDb(db),
  logger: { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
  ...(setup ? { setup } : {}),
});

// In-process events (D-04). Until the realtime and ntfy modules subscribe (P3 task 6, P8),
// security alerts reach the owner through the log and, for warn and critical ones, Sentry's
// e-mail alerts (ids and event names only). Events hold ids, not secrets.
const events = createEventBus((error) => app.log.error({ err: error }, 'event subscriber failed'));
events.subscribe((event) => {
  if (event.type === 'alert.security') {
    app.log.warn(
      {
        alert: event.kind,
        severity: event.severity,
        staffId: event.staffId,
        deviceId: event.deviceId,
      },
      'security alert',
    );
  }
});
if (reportAlert) forwardAlerts(events, reportAlert);
const line = createLineRuntime(config.line, { privacy: config.privacy });
// Slips (90 days) and expense receipt photos (5 years) are two stores that never share a listing
// (D-36): on R2 two prefixes of one bucket, without R2 two folders on the slips volume. The orphan
// sweep and the retention job only ever see `slips`.
const slips = config.r2
  ? createR2SlipStore({ ...config.r2, prefix: R2_SLIP_PREFIX })
  : createFsSlipStore(config.slipDir);
// Receipt photos are 5-year records: without R2 they are refused (503) rather than kept on the slips volume, which has no off-site copy.
const receipts = config.r2
  ? createR2SlipStore({ ...config.r2, prefix: R2_RECEIPT_PREFIX })
  : undefined;
// The automatic reading of slips, one picture at a time: the amount with Tesseract on this machine
// (D-26) and/or the bank check by Slip2Go (D-27). The checker starts when either is on.
const verifier = config.slipVerifier
  ? createSlip2goVerifier({ ...config.slipVerifier, log: app.log })
  : null;
installSlipVerifier(verifier);
// One reader serves the checker and the late-slip keeper (D-41).
const qrReader = config.slipQr ? createWorkerQrReader() : null;
installSlipQrReader(qrReader);
if (config.slipOcr || verifier) {
  installSlipChecker(
    createSlipChecker({
      ctx: { db, now: () => new Date(), events },
      slips,
      ...(config.slipOcr ? { ocr: createTesseractOcr(config.slipOcr) } : {}),
      ...(qrReader ? { qr: qrReader } : {}),
      ...(verifier && config.slipVerifier
        ? {
            verifier,
            dailyCap: config.slipVerifier.dailyCap,
            autoConfirm: config.slipAutoconfirm,
            firstCallDelayMs: SLIP_FIRST_CALL_DELAY_MS,
            firstCallDelayByBankMs: SLIP_FIRST_CALL_DELAY_BY_BANK_MS,
          }
        : {}),
      log: app.log,
    }),
  );
}
await registerV1(app, {
  db,
  authSecretKey: config.authSecretKey,
  events,
  line,
  slips,
  ...(receipts ? { receipts } : {}),
  ...(config.vapid ? { push: { vapid: config.vapid } } : {}),
  ...(config.telegram
    ? {
        telegram: {
          token: config.telegram.botToken,
          chatId: config.telegram.chatId,
          publicBaseUrl: config.telegram.publicBaseUrl,
        },
      }
    : {}),
});

// 0.0.0.0 so Caddy can reach the container over the Docker network.
await app.listen({ host: '0.0.0.0', port: config.port });

// Background jobs (D-16), started AFTER the server listens and in the background, so /healthz
// never waits on pg-boss. A failed start is logged (class name and code only), retried with
// backoff up to 5 minutes, and the owner is alerted (no personal data in the event).
const jobs = superviseJobs({
  start: () =>
    startJobs({
      databaseUrl: config.databaseUrl,
      deps: { db, events, now: () => new Date(), line, slips, ...(receipts ? { receipts } : {}) },
      log: app.log,
    }),
  onFailure: (failure) => {
    app.log.error(
      { attempt: failure.attempt, errorName: failure.errorName, code: failure.code },
      'jobs not started, will retry',
    );
    if (alertOnAttempt(failure.attempt)) {
      events.publish({
        type: 'alert.security',
        kind: 'jobs.start_failed',
        severity: 'warn',
        at: new Date().toISOString(),
        staffId: null,
        deviceId: null,
      });
    }
  },
});

// A pool that fails while fresh connections work is wedged (seen 2026-10-04: queries hung while
// the database was healthy, cause not found yet): exit so Docker restarts the API. A real
// database outage does not trigger this.
const watchdog = createPoolWatchdog({
  checkPool: () => pingDb(db),
  checkFresh: () => pingFreshDb(config.databaseUrl),
  onWedged: () => {
    app.log.error('database pool is wedged while the database is reachable, exiting to restart');
    process.exit(1);
  },
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  watchdog.stop();
  await jobs.stop();
  await app.close();
  await close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
