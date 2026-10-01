import { createDb, pingDb } from '@sds/db';
import type { FastifyInstance } from 'fastify';
import { type AlertReport, forwardAlerts } from './alerts.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createEventBus } from './events.ts';
import { sentryOptions } from './redact.ts';
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
await registerV1(app, { db, authSecretKey: config.authSecretKey, events });

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

// 0.0.0.0 so Caddy can reach the container over the Docker network.
await app.listen({ host: '0.0.0.0', port: config.port });
