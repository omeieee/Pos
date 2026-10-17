import { formatBaht } from '@sds/i18n';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import type { ChannelShare } from './report-model.ts';

/**
 * Sales by channel as one stacked bar (part of a whole), a legend that names every channel with
 * its share and amount, and the same numbers as a table. Each channel keeps its own colour slot
 * whatever else is on screen; the names carry the meaning, so colour is never the only cue.
 */
export function ChannelCard({ shares }: { shares: readonly ChannelShare[] }) {
  const tr = useT();
  const locale = useLocale();
  const money = (satang: number) => formatBaht(satang, locale, { decimals: 'auto' });
  const name = (channel: ChannelShare['channel']) => tr(`orders.channel.${channel}`);
  const summary = tr('dash.channels.summary', {
    parts: shares
      .map((c) => tr('dash.channels.part', { name: name(c.channel), percent: c.percent }))
      .join(', '),
  });

  return (
    <div className="g-glass g-rise rpt-card" style={s('--d:.23s')}>
      <div className="g-t-2">{tr('dash.channels')}</div>
      {shares.length === 0 ? (
        <div className="g-t-s">{tr('dash.empty')}</div>
      ) : (
        <>
          <div className="rpt-stack" role="img" aria-label={summary}>
            {shares.map((c) => (
              <span
                key={c.channel}
                className={`rpt-stack__seg rpt-stack__seg--${c.slot}`}
                style={s(`flex-grow:${c.amountSatang}`)}
              />
            ))}
          </div>
          <ul className="rpt-legend">
            {shares.map((c) => (
              <li key={c.channel} className="rpt-legend__row">
                <span className={`rpt-swatch rpt-swatch--${c.slot}`} aria-hidden="true" />
                <span className="g-t-s rpt-legend__name">{name(c.channel)}</span>
                <span className="g-num g-t-3" style={s('font-size:15px')}>
                  {c.percent}% · {money(c.amountSatang)}
                </span>
              </li>
            ))}
          </ul>
          <details className="rpt-details">
            <summary className="g-t-s">{tr('dash.table.show')}</summary>
            <table className="rpt-table">
              <thead>
                <tr>
                  <th scope="col">{tr('dash.table.channel')}</th>
                  <th scope="col" className="rpt-num">
                    {tr('dash.table.amount')}
                  </th>
                  <th scope="col" className="rpt-num">
                    {tr('dash.table.share')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shares.map((c) => (
                  <tr key={c.channel}>
                    <th scope="row">{name(c.channel)}</th>
                    <td className="rpt-num">{money(c.amountSatang)}</td>
                    <td className="rpt-num">{c.percent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
      <div
        className="g-sunk"
        style={s('padding:12px 14px;display:flex;gap:10px;align-items:center')}
      >
        <div className="g-t-s" style={s('line-height:1.45')}>
          {tr('dash.entranceNote')}
        </div>
      </div>
    </div>
  );
}
