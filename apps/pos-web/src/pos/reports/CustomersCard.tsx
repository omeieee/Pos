import { formatBaht } from '@sds/i18n';
import type { CustomersReport } from '@sds/shared';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import type { ReportLoad } from './use-report-data.ts';

const SHOWN = 8;

/**
 * The customer list for the owner: how many are new, regular or lapsed, and the most recent
 * customers with what they spent and their favourite items. Personal data (PDPA), so the screen
 * only mounts this for a role that holds `customer.report`; the API refuses everyone else.
 */
export function CustomersCard({
  load,
  report,
  onRetry,
}: {
  load: ReportLoad;
  report: CustomersReport | null;
  onRetry: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const money = (satang: number) => formatBaht(satang, locale, { decimals: 'auto' });
  return (
    <div className="g-glass g-rise rpt-card" style={s('flex:2 1 520px;--d:.39s')}>
      <div style={s('display:flex;align-items:baseline;gap:10px;flex-wrap:wrap')}>
        <div className="g-t-2" style={s('flex-grow:1')}>
          {tr('dash.customers.title')}
        </div>
        <span className="g-badge g-b-mute">{tr('dash.customers.ownerOnly')}</span>
      </div>
      {load === 'loading' && <div className="g-t-s">{tr('dash.loading')}</div>}
      {load === 'error' && (
        <div role="alert" style={s('display:flex;gap:10px;align-items:center;flex-wrap:wrap')}>
          <span className="g-t-s">{tr('dash.error')}</span>
          <button type="button" className="g-btn" onClick={onRetry}>
            {tr('common.retry')}
          </button>
        </div>
      )}
      {load === 'ok' && report && (
        <>
          <div className="rpt-segments">
            {(['new', 'regular', 'lapsed'] as const).map((segment) => (
              <div key={segment} className="g-sunk rpt-segment">
                <span className="g-t-s">{tr(`dash.customers.${segment}`)}</span>
                <span className="g-num" style={s('font-size:28px;font-weight:600')}>
                  {report.summary[segment]}
                </span>
              </div>
            ))}
          </div>
          <div className="g-t-c">{tr('dash.customers.rule')}</div>
          {report.customers.length === 0 ? (
            <div className="g-t-s">{tr('dash.customers.none')}</div>
          ) : (
            <div className="rpt-heat-wrap">
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th scope="col">{tr('dash.customers.col.name')}</th>
                    <th scope="col">{tr('dash.customers.col.segment')}</th>
                    <th scope="col" className="rpt-num">
                      {tr('dash.customers.col.orders')}
                    </th>
                    <th scope="col" className="rpt-num">
                      {tr('dash.customers.col.spent')}
                    </th>
                    <th scope="col">{tr('dash.customers.col.favourites')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.customers.slice(0, SHOWN).map((c) => (
                    <tr key={c.id}>
                      <th scope="row">
                        {c.name ?? tr('dash.customers.noName')}
                        {c.building ? <span className="g-t-c"> · {c.building}</span> : null}
                      </th>
                      <td>{tr(`dash.customers.${c.segment}`)}</td>
                      <td className="rpt-num">{c.orderCount}</td>
                      <td className="rpt-num">{money(c.totalSpentSatang)}</td>
                      <td>{c.favourites.map((f) => f.name).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
