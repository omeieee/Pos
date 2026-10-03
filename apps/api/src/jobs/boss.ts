import { postgresOptions } from '@sds/db';
import { type ConstructorOptions, PgBoss } from 'pg-boss';
import { JOBS, type JobDeps } from './jobs.ts';

export interface JobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const SSL_URL_PARAMS = [
  'sslmode',
  'ssl',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslnegotiation',
  'uselibpqcompat',
];

/**
 * pg-boss uses node-postgres, which reads TLS from the URL and lets the URL win over an explicit
 * option. The rest of the API uses postgres-js with `postgresOptions`: TLS is forced for any
 * non-loopback host, `sslmode=require` encrypts without checking the certificate (Supabase's
 * pooler certificate is not in the default trust store), and only a verifying mode verifies. This
 * gives pg-boss the same: the URL without its TLS parameters, and the equivalent `ssl` option.
 */
export function pgBossConnection(databaseUrl: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  const mode = postgresOptions(databaseUrl, 1).ssl;
  let connectionString = databaseUrl;
  try {
    const url = new URL(databaseUrl);
    for (const name of SSL_URL_PARAMS) url.searchParams.delete(name);
    connectionString = url.toString();
  } catch {
    // Not a parsable URL: let the driver reject it, with TLS still forced below.
  }
  if (mode === undefined) return { connectionString };
  return { connectionString, ssl: { rejectUnauthorized: mode === 'verify-full' } };
}

/**
 * Starts pg-boss (D-16) inside the API process and registers every job in `JOBS` on its cron.
 * pg-boss keeps its tables in its own `pgboss` schema and opens a small pool of its own. A failed
 * run is logged by job name and error class (never a message: it could hold personal data) and
 * is not retried by pg-boss: the next cron tick is the retry, and every job is idempotent.
 * Call it from `server.ts` only; tests call the job functions directly.
 */
export async function startJobs(args: {
  databaseUrl: string;
  deps: JobDeps;
  log: JobLogger;
  /** Tests pass a fake. */
  createBoss?: (options: ConstructorOptions) => PgBoss;
}): Promise<{ stop(): Promise<void> }> {
  const options: ConstructorOptions = {
    ...pgBossConnection(args.databaseUrl),
    schema: 'pgboss',
    max: 2,
    application_name: 'sds-api-jobs',
  };
  const boss = args.createBoss ? args.createBoss(options) : new PgBoss(options);
  boss.on('error', (error) => {
    args.log.error({ errorName: error instanceof Error ? error.name : 'Error' }, 'job queue error');
  });
  const stop = () => boss.stop({ graceful: true, timeout: 10_000 });
  try {
    await boss.start();
    for (const job of JOBS) {
      await boss.createQueue(job.name, { retryLimit: 0, expireInSeconds: 600 });
      await boss.work(job.name, async () => {
        try {
          const counts = await job.run(args.deps);
          args.log.info({ job: job.name, ...counts }, 'job finished');
        } catch (error) {
          args.log.error(
            { job: job.name, errorName: error instanceof Error ? error.name : 'Error' },
            'job failed',
          );
          throw error;
        }
      });
      await boss.schedule(job.name, job.cron, null, { tz: 'Asia/Bangkok' });
    }
  } catch (error) {
    // Do not leak the pool, the workers or the timers of a half-started queue.
    await stop().catch(() => undefined);
    throw error;
  }
  return { stop };
}
