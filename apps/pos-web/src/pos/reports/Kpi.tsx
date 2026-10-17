import { formatBaht } from '@sds/i18n';
import { Gi, type GiName } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import type { Comparison, Period } from './report-model.ts';

/** A change against the period before: an arrow and word (never colour alone), and the size. */
export function Delta({ change, unit }: { change: Comparison; unit: 'money' | 'count' }) {
  const tr = useT();
  const locale = useLocale();
  if (change.direction === 'flat') {
    return (
      <span className="g-badge g-b-mute">
        <Gi n="minus" />
        {tr('dash.delta.flat')}
      </span>
    );
  }
  const size =
    change.tenthsPercent === null
      ? unit === 'money'
        ? formatBaht(Math.abs(change.diff), locale, { decimals: 'auto' })
        : tr('dash.orderUnit', { count: Math.abs(change.diff) })
      : `${(change.tenthsPercent / 10).toFixed(1)}%`;
  const up = change.direction === 'up';
  return (
    <span className={`g-badge ${up ? 'g-b-ok' : 'g-b-bad'}`}>
      <Gi n={up ? 'chevronUp' : 'chevronDown'} />
      {tr(up ? 'dash.delta.up' : 'dash.delta.down', { value: size })}
    </span>
  );
}

/** The "compared with" line: the earlier figure, or a note when there was nothing to compare with. */
export function VsPrevious({ period, value }: { period: Period; value: string | null }) {
  const tr = useT();
  return (
    <span className="g-t-c">
      {value === null ? tr('dash.vs.none') : tr(`dash.vs.${period}`, { value })}
    </span>
  );
}

export function Kpi({
  delay,
  color,
  icon,
  label,
  value,
  children,
}: {
  delay: string;
  color: string;
  icon: GiName;
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="g-glass g-rise"
      style={s(`padding:20px 22px;display:flex;flex-direction:column;gap:6px;--d:${delay}`)}
    >
      <div className="g-t-s" style={s('display:flex;align-items:center;gap:8px')}>
        <span
          className="g-ico"
          style={s(`width:30px;height:30px;border-radius:10px;background:${color}`)}
        >
          <Gi n={icon} size="sm" />
        </span>
        {label}
      </div>
      <div className="g-num" style={s('font-size:36px;line-height:1.3;font-weight:600')}>
        {value}
      </div>
      <div style={s('display:flex;gap:8px;align-items:center;flex-wrap:wrap')}>{children}</div>
    </div>
  );
}
