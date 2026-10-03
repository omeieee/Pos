import { PgBoss } from 'pg-boss';
import { JOBS, type JobDeps } from './jobs.ts';

export interface JobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
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
}): Promise<{ stop(): Promise<void> }> {
  const boss = new PgBoss({
    connectionString: args.databaseUrl,
    schema: 'pgboss',
    max: 2,
    application_name: 'sds-api-jobs',
  });
  boss.on('error', (error) => {
    args.log.error({ errorName: error instanceof Error ? error.name : 'Error' }, 'job queue error');
  });
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
  return { stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
