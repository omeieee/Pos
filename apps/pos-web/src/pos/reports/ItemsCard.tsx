import type { ItemSalesDto } from '@sds/shared';
import { s } from '../../design/style.ts';
import { useT } from '../../ui/hooks.ts';
import { bottomItems, topItems } from './report-model.ts';

const SHOWN = 5;

function Bars({ items, max }: { items: readonly ItemSalesDto[]; max: number }) {
  const tr = useT();
  return (
    <ul className="rpt-bars">
      {items.map((item) => (
        <li key={item.menuItemId} className="rpt-bar">
          <span className="g-t-s rpt-bar__name">{item.name}</span>
          <span className="rpt-bar__track" aria-hidden="true">
            <span
              className="rpt-bar__fill"
              style={s(`width:${Math.max(2, Math.round((item.qty / max) * 100))}%`)}
            />
          </span>
          <span className="g-num g-t-3 rpt-bar__value" style={s('font-size:15px')}>
            {item.qty}
            <span className="visually-hidden"> {tr('dash.soldQty')}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Best sellers (a bar per item, one hue) and the slowest ones, by units sold. The list the API
 * sends is already best first; a short list is not shown twice.
 */
export function ItemsCard({ items }: { items: readonly ItemSalesDto[] }) {
  const tr = useT();
  const best = topItems(items, SHOWN);
  const worst = bottomItems(items, SHOWN, best.length);
  const max = best[0]?.qty ?? 1;
  return (
    <div className="g-glass g-rise rpt-card" style={s('--d:.27s')}>
      <div style={s('display:flex;align-items:baseline')}>
        <div className="g-t-2" style={s('flex-grow:1')}>
          {tr('dash.topItems')}
        </div>
        <span className="g-t-c">{tr('dash.soldQty')}</span>
      </div>
      {best.length === 0 ? (
        <div className="g-t-s">{tr('dash.items.none')}</div>
      ) : (
        <Bars items={best} max={max} />
      )}
      {worst.length > 0 && (
        <>
          <div className="g-t-2">{tr('dash.items.bottom')}</div>
          <Bars items={worst} max={max} />
        </>
      )}
    </div>
  );
}
