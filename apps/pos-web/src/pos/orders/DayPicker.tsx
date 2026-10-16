/**
 * Orders board: the day picker, the past-day note and the empty-list text.
 */
import { weekdayDate } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import type { Tr } from './list-parts.tsx';

/**
 * Which business day to look at: the date box (any past day, so an old order can be found, opened
 * and corrected by the owner) and a quick way back to today. The day is a business date.
 */
export function DayPicker({
  day,
  today,
  onPick,
  onOpenMonth,
}: {
  day: string;
  today: string;
  onPick: (day: string | null) => void;
  onOpenMonth: () => void;
}) {
  const tr = useT();
  return (
    <div style={s('display:flex;align-items:center;gap:8px;flex:none')}>
      <button
        type="button"
        className="g-btn g-btn-icon"
        style={s('width:46px;height:46px;padding:0;flex:none')}
        aria-label={tr('orders.month.open')}
        title={tr('orders.month.open')}
        onClick={onOpenMonth}
      >
        <Gi n="grid" />
      </button>
      <label
        className="g-field"
        style={s(
          'height:46px;border-radius:999px;background:var(--glass);border-color:var(--line)',
        )}
      >
        <Gi n="clock" size="sm" />
        <input
          type="date"
          aria-label={tr('orders.day.label')}
          value={day}
          max={today}
          onChange={(event) => {
            const value = event.target.value;
            if (value) onPick(value >= today ? null : value);
          }}
        />
      </label>
      {day === today ? null : (
        <button type="button" className="g-btn" onClick={() => onPick(null)}>
          {tr('orders.day.today')}
        </button>
      )}
    </div>
  );
}

export function PastDayNote({ day }: { day: string }) {
  const tr = useT();
  const locale = useLocale();
  return (
    <p className="g-t-s" role="status" style={s('margin:0')}>
      {tr('orders.day.past', { date: weekdayDate(Date.parse(`${day}T12:00:00+07:00`), locale) })}
    </p>
  );
}

export function emptyText(
  tr: Tr,
  load: 'loading' | 'ok' | 'error',
  anyToday: boolean,
  query: string,
  isToday = true,
): { text: string; status: boolean } {
  if (!anyToday) {
    return load === 'loading'
      ? { text: tr('orders.loading'), status: true }
      : { text: tr(isToday ? 'orders.empty' : 'orders.day.empty'), status: false };
  }
  return { text: tr(query.trim() === '' ? 'orders.emptyFilter' : 'orders.noMatch'), status: false };
}
