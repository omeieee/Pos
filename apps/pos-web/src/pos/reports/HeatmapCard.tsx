import type { HeatCellDto } from '@sds/shared';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import { heatGrid, heatLevel, weekdayShort } from './report-model.ts';

/**
 * When customers order: orders by business day (rows, Monday first) and the hour they were placed
 * (columns). One hue from light to dark, four steps, with the count written in every busy cell,
 * so the numbers are readable without the colour. The grid is a real table, which is also the
 * table view. The weekday is the business day's: a 00:30 order sits under the day before.
 */
export function HeatmapCard({ cells }: { cells: readonly HeatCellDto[] }) {
  const tr = useT();
  const locale = useLocale();
  const grid = heatGrid(cells);
  const busiest = cells.reduce<HeatCellDto | null>(
    (best, c) => (best === null || c.orderCount > best.orderCount ? c : best),
    null,
  );
  const label = (weekday: number, hour: number, count: number) =>
    tr('dash.heat.cell', { day: weekdayShort(weekday, locale), hour, count });

  return (
    <div className="g-glass g-rise rpt-card" style={s('flex:2 1 520px;--d:.19s')}>
      <div className="g-t-2">{tr('dash.heat.title')}</div>
      <div className="g-t-c">{tr('dash.heat.hint')}</div>
      {busiest === null ? (
        <div className="g-t-s">{tr('dash.empty')}</div>
      ) : (
        <>
          <div className="rpt-heat-wrap">
            <table
              className="rpt-heat"
              aria-label={tr('dash.heat.alt', {
                day: weekdayShort(busiest.weekday, locale),
                hour: busiest.hour,
                count: busiest.orderCount,
              })}
            >
              <thead>
                <tr>
                  <td />
                  {grid.hours.map((hour) => (
                    <th key={hour} scope="col" className="g-t-c">
                      {hour}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row.weekday}>
                    <th scope="row" className="g-t-c">
                      {weekdayShort(row.weekday, locale)}
                    </th>
                    {row.counts.map((count, i) => {
                      const hour = grid.hours[i] ?? 0;
                      const level = heatLevel(count, grid.max);
                      return (
                        <td
                          key={hour}
                          className={level === 0 ? undefined : `rpt-heat__${level}`}
                          title={label(row.weekday, hour, count)}
                        >
                          {count === 0 ? (
                            <span className="visually-hidden">{label(row.weekday, hour, 0)}</span>
                          ) : (
                            count
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rpt-ramp g-t-c" aria-hidden="true">
            {tr('dash.heat.less')}
            {[1, 2, 3, 4].map((level) => (
              <span key={level} className={`rpt-ramp__step rpt-heat__${level}`} />
            ))}
            {tr('dash.heat.more')}
          </div>
        </>
      )}
    </div>
  );
}
