import { formatBaht } from '@sds/i18n';
import type { ItemDto } from '@sds/shared';
import { useState } from 'react';
import { apiUrl } from '../platform/config.ts';
import { localName } from '../pos/names.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { useEditorContext } from './editor-context.ts';
import { categoryRows, itemRowsOf } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowButtons, SoldOutSwitch } from './RowParts.tsx';

function ItemRow({
  item,
  liveIds,
  archived,
}: {
  item: ItemDto;
  liveIds: readonly string[];
  archived: boolean;
}) {
  const { menuEditor } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const locale = useLocale();
  const name = localName(locale, item.nameTh, item.nameEn);
  const rowBusy = ctx.pending.includes(rowKey(item.id));
  const listBusy = ctx.pending.includes(reorderKey('items', item.categoryId));
  const cost = ctx.costs?.items[item.id];
  const channels = item.channels.map((c) => tr(`orders.channel.${c}`)).join(' · ');

  return (
    <li className={`mrow${archived ? ' mrow--archived' : ''}`}>
      <span className="mrow__thumb" aria-hidden="true">
        {item.photoUrl ? (
          <img src={apiUrl(item.photoUrl)} alt="" loading="lazy" width="56" height="56" />
        ) : (
          <Icon name="bowl" />
        )}
      </span>
      <span className="mrow__main">
        <span className="mrow__name">{name}</span>
        <span className="mrow__meta">
          <span className="money">
            {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
          </span>
          {cost === undefined ? null : (
            <span className="muted">
              {tr('menuEditor.costLabel', {
                amount: formatBaht(cost, locale, { decimals: 'auto' }),
              })}
            </span>
          )}
          <span className="muted">{tr('menuEditor.channels.on', { channels })}</span>
        </span>
      </span>
      <span className="mrow__actions">
        {archived ? (
          <span className="tag">{tr('menuEditor.archived')}</span>
        ) : (
          <>
            <SoldOutSwitch
              name={name}
              soldOut={!item.isAvailable}
              disabled={ctx.offline || rowBusy}
              onChange={(soldOut) => void ctx.run(menuEditor.setItemAvailable(item, !soldOut))}
            />
            <MoveButtons
              ids={liveIds}
              id={item.id}
              name={name}
              disabled={ctx.offline || listBusy}
              onMove={(order) => void ctx.run(menuEditor.reorder('items', item.categoryId, order))}
            />
          </>
        )}
        <RowButtons
          name={name}
          archived={archived}
          disabled={ctx.offline || rowBusy}
          {...(archived
            ? {}
            : {
                onEdit: () =>
                  ctx.open({ kind: 'item', categoryId: item.categoryId, itemId: item.id }),
              })}
          onArchive={() => void ctx.run(menuEditor.setItemArchived(item, true))}
          onRestore={() => void ctx.run(menuEditor.setItemArchived(item, false))}
        />
      </span>
    </li>
  );
}

/** The dishes of one category: sold-out switch, order, edit, archive; archived ones on request. */
export function ItemsTab() {
  const tr = useT();
  const locale = useLocale();
  const state = useEntities();
  const ctx = useEditorContext();
  const categories = categoryRows(state);
  const [chosen, setChosen] = useState<string | null>(null);
  const category = categories.find((c) => c.id === chosen) ?? categories[0];

  if (!category) return <p className="muted medit__empty">{tr('menuEditor.empty.categories')}</p>;
  const { live, archived } = itemRowsOf(state, category.id);
  const liveIds = live.map((i) => i.id);

  return (
    <div className="medit__panel">
      <fieldset className="mcats">
        <legend className="visually-hidden">{tr('menuEditor.category.pick')}</legend>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`choice${c.id === category.id ? ' choice--on' : ''}`}
            aria-pressed={c.id === category.id}
            onClick={() => setChosen(c.id)}
          >
            {localName(locale, c.nameTh, c.nameEn)}
            {c.active ? '' : ` (${tr('menuEditor.category.off')})`}
          </button>
        ))}
      </fieldset>

      <div className="medit__bar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'item', categoryId: category.id })}
        >
          <Icon name="plus" />
          <span>{tr('menuEditor.add.item')}</span>
        </button>
      </div>

      {live.length === 0 ? (
        <p className="muted medit__empty">{tr('menuEditor.empty.items')}</p>
      ) : (
        <ul className="mlist">
          {live.map((item) => (
            <ItemRow key={item.id} item={item} liveIds={liveIds} archived={false} />
          ))}
        </ul>
      )}

      {ctx.showArchived && archived.length > 0 ? (
        <>
          <h2 className="medit__sub">{tr('menuEditor.archivedHeading')}</h2>
          <ul className="mlist">
            {archived.map((item) => (
              <ItemRow key={item.id} item={item} liveIds={liveIds} archived />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
