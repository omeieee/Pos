import { useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useAuthStore, useServices, useT } from '../../ui/hooks.ts';
import type { DateRange } from './report-model.ts';

type Kind = 'revenue' | 'items';
type Outcome = { kind: 'done'; name: string } | { kind: 'failed' } | null;

/**
 * The accountant's CSV files for the period on screen. A step-up call (owner only): the auth store
 * asks the owner to confirm first and again if the server says so; cancelling it says nothing. The
 * file is saved through the platform's file output, and the API writes the audit row.
 */
export function ExportButtons({ range }: { range: DateRange }) {
  const tr = useT();
  const auth = useAuthStore();
  const { api, files } = useServices();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function run(kind: Kind) {
    setBusy(kind);
    setOutcome(null);
    const result = await auth.runSensitive(() => api.reports.exportCsv(kind, range));
    setBusy(null);
    if (result.ok) {
      files.save(result.value.filename, 'text/csv', result.value.text);
      setOutcome({ kind: 'done', name: result.value.filename });
    } else if (result.error !== null) {
      setOutcome({ kind: 'failed' });
    }
  }

  return (
    <>
      {(['revenue', 'items'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          className="g-btn"
          disabled={busy !== null}
          onClick={() => void run(kind)}
        >
          <Gi n="download" size="sm" />
          {tr(kind === 'revenue' ? 'dash.export.revenue' : 'dash.export.items')}
        </button>
      ))}
      <span role="status" className="g-t-c" style={s('align-self:center')}>
        {outcome?.kind === 'done' && tr('dash.export.done', { name: outcome.name })}
        {outcome?.kind === 'failed' && tr('dash.export.failed')}
      </span>
    </>
  );
}
