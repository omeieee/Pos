import { formatBaht } from '@sds/i18n';
import type { ItemDto } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { apiUrl } from '../platform/config.ts';
import { localName } from '../pos/names.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { useEditorContext } from './editor-context.ts';
import { categoryRows, itemRowsOf } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowBadge, RowButtons, SoldOutSwitch, Thumb } from './RowParts.tsx';
import './menu-glass.css';

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
    <li className={`g-row merow${archived ? ' merow--archived' : ''}`}>
      <Thumb id={item.id} src={item.photoUrl ? apiUrl(item.photoUrl) : null} />
      <span className="merow__main">
        <span className="merow__name">{name}</span>
        <span className="merow__meta">
          <span className="merow__price g-num">
            {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
          </span>
          {cost === undefined ? null : (
            <span>
              {tr('menuEditor.costLabel', {
                amount: formatBaht(cost, locale, { decimals: 'auto' }),
              })}
            </span>
          )}
          <span>{tr('menuEditor.channels.on', { channels })}</span>
        </span>
        {archived || !item.isAvailable ? (
          <span className="merow__badges">
            {archived ? (
              <RowBadge tone="mute" icon="x">
                {tr('menuEditor.archived')}
              </RowBadge>
            ) : (
              <RowBadge tone="warn" icon="warn">
                {tr('menuEditor.soldOut')}
              </RowBadge>
            )}
          </span>
        ) : null}
      </span>
      <span className="merow__actions">
        {archived ? null : (
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

  if (!category)
    return (
      <p className="g-t-s" style={s('margin:0')}>
        {tr('menuEditor.empty.categories')}
      </p>
    );
  const { live, archived } = itemRowsOf(state, category.id);
  const liveIds = live.map((i) => i.id);

  return (
    <div style={s('display:flex;flex-direction:column;gap:16px;min-width:0')}>
      <fieldset className="mscroll">
        <legend className="gvh">{tr('menuEditor.category.pick')}</legend>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={c.id === category.id ? 'g-chip g-on' : 'g-chip'}
            aria-pressed={c.id === category.id}
            onClick={() => setChosen(c.id)}
          >
            {localName(locale, c.nameTh, c.nameEn)}
            {c.active ? '' : ` (${tr('menuEditor.category.off')})`}
          </button>
        ))}
      </fieldset>

      <div>
        <button
          type="button"
          className="g-btn g-btn-p"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'item', categoryId: category.id })}
        >
          <Gi n="plus" size="sm" />
          <span>{tr('menuEditor.add.item')}</span>
        </button>
      </div>

      {live.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('menuEditor.empty.items')}
        </p>
      ) : (
        <ul className="g-glass gset-grp gset-list">
          {live.map((item) => (
            <ItemRow key={item.id} item={item} liveIds={liveIds} archived={false} />
          ))}
        </ul>
      )}

      {ctx.showArchived && archived.length > 0 ? (
        <>
          <h2 className="gset-lbl" style={s('margin:0;padding-bottom:0')}>
            {tr('menuEditor.archivedHeading')}
          </h2>
          <ul className="g-glass gset-grp gset-list" style={s('margin-top:-8px')}>
            {archived.map((item) => (
              <ItemRow key={item.id} item={item} liveIds={liveIds} archived />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
