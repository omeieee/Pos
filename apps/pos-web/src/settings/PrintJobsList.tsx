import { formatDate } from '@sds/i18n';
import type { PrintJobDto, PrintJobStatus } from '@sds/shared';
import { useEffect } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';

/** How often the list reads again while the page is open (ms). */
const REFRESH_MS = 10_000;

/** Colour + icon + words, always together (brand §3). */
const STATUS: Record<PrintJobStatus, { tone: 'warn' | 'info' | 'ok' | 'bad'; icon: GiName }> = {
  pending: { tone: 'warn', icon: 'clock' },
  claimed: { tone: 'info', icon: 'pending' },
  printed: { tone: 'ok', icon: 'check' },
  failed: { tone: 'bad', icon: 'x' },
};

function JobRow({ job }: { job: PrintJobDto }) {
  const tr = useT();
  const locale = useLocale();
  const { tone, icon } = STATUS[job.status];
  return (
    <li
      style={s('display:flex;align-items:center;gap:12px;min-height:44px;flex-wrap:wrap')}
      data-status={job.status}
    >
      <div style={s('flex:1 1 140px;min-width:0')}>
        <div className="g-t-3" style={s('font-weight:500')}>
          {job.orderNo}
        </div>
        <div className="g-t-c">
          {job.kind === 'reprint'
            ? tr('settings.printing.jobs.kind.reprint', { seq: job.seq })
            : tr('settings.printing.jobs.kind.kitchen')}
          {` · ${formatDate(job.createdAt, locale, 'time')}`}
          {job.status === 'failed' && job.lastError
            ? ` · ${tr(`settings.printing.jobs.error.${job.lastError}`)}`
            : ''}
        </div>
      </div>
      <span className={`g-badge g-b-${tone} status`}>
        <Gi n={icon} />
        {tr(`settings.printing.jobs.status.${job.status}`)}
      </span>
    </li>
  );
}

/**
 * The newest print jobs and where each one is: waiting, printing, printed, failed. It shows staff
 * whether the print notebook is picking jobs up. Read-only; it reads when the page opens, every few
 * seconds while it stays open, and on the refresh button.
 */
export function PrintJobsList() {
  const { print } = useServices();
  const state = useStoreState(print).jobs;
  const tr = useT();

  useEffect(() => {
    void print.loadJobs();
    const timer = setInterval(() => void print.loadJobs(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [print]);

  return (
    <FormCard>
      <div style={s('display:flex;align-items:center;gap:12px')}>
        <h2 className="g-t-2" style={s('margin:0;flex:1 1 auto')}>
          {tr('settings.printing.jobs.title')}
        </h2>
        <button type="button" className="g-btn gbtn-row" onClick={() => void print.loadJobs()}>
          {tr('settings.printing.jobs.refresh')}
        </button>
      </div>
      <p className="g-t-s" style={s('margin:0')}>
        {tr('settings.printing.jobs.hint')}
      </p>
      {state.status === 'loading' && state.jobs.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')} role="status">
          {tr('settings.printing.jobs.loading')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <Callout tone="bad" role="alert">
          {tr('settings.printing.jobs.loadFailed')}
        </Callout>
      ) : null}
      {state.status === 'ready' && state.jobs.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.printing.jobs.empty')}
        </p>
      ) : null}
      {state.jobs.length > 0 ? (
        <ul
          aria-label={tr('settings.printing.jobs.listLabel')}
          style={s(
            'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px',
          )}
        >
          {state.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      ) : null}
    </FormCard>
  );
}
