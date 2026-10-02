import { formatBaht } from '@sds/i18n';
import type { OptionDto } from '@sds/shared';
import { localName } from '../pos/names.ts';
import type { GroupWithOptions } from '../realtime/selectors.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { useEditorContext } from './editor-context.ts';
import { groupRows, optionRowsOf } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowButtons, SoldOutSwitch } from './RowParts.tsx';

/** A price change as text: "+฿10", "-฿5", or "no price change". */
function useDeltaText() {
  const tr = useT();
  const locale = useLocale();
  return (satang: number) =>
    satang === 0
      ? tr('menuEditor.option.noPriceChange')
      : tr('menuEditor.option.priceDelta', {
          amount: `${satang > 0 ? '+' : ''}${formatBaht(satang, locale, { decimals: 'auto' })}`,
        });
}

function OptionRow({
  option,
  group,
  liveIds,
  archived,
}: {
  option: OptionDto;
  group: GroupWithOptions;
  liveIds: readonly string[];
  archived: boolean;
}) {
  const { menuEditor } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const locale = useLocale();
  const delta = useDeltaText();
  const name = localName(locale, option.nameTh, option.nameEn);
  const rowBusy = ctx.pending.includes(rowKey(option.id));
  const listBusy = ctx.pending.includes(reorderKey('options', group.id));
  const cost = ctx.costs?.options[option.id];

  return (
    <li className={`mrow mrow--option${archived ? ' mrow--archived' : ''}`}>
      <span className="mrow__main">
        <span className="mrow__name">{name}</span>
        <span className="mrow__meta">
          <span className="money">{delta(option.priceDeltaSatang)}</span>
          {cost === undefined ? null : (
            <span className="muted">
              {tr('menuEditor.option.costDelta', {
                amount: `${cost > 0 ? '+' : ''}${formatBaht(cost, locale, { decimals: 'auto' })}`,
              })}
            </span>
          )}
        </span>
      </span>
      <span className="mrow__actions">
        {archived ? (
          <span className="tag">{tr('menuEditor.archived')}</span>
        ) : (
          <>
            <SoldOutSwitch
              name={name}
              soldOut={!option.isAvailable}
              disabled={ctx.offline || rowBusy}
              onChange={(soldOut) => void ctx.run(menuEditor.setOptionAvailable(option, !soldOut))}
            />
            <MoveButtons
              ids={liveIds}
              id={option.id}
              name={name}
              disabled={ctx.offline || listBusy}
              onMove={(order) => void ctx.run(menuEditor.reorder('options', group.id, order))}
            />
          </>
        )}
        <RowButtons
          name={name}
          archived={archived}
          disabled={ctx.offline || rowBusy}
          {...(archived
            ? {}
            : { onEdit: () => ctx.open({ kind: 'option', groupId: group.id, id: option.id }) })}
          onArchive={() => void ctx.run(menuEditor.setOptionArchived(option, true))}
          onRestore={() => void ctx.run(menuEditor.setOptionArchived(option, false))}
        />
      </span>
    </li>
  );
}

function GroupCard({
  group,
  liveIds,
  archived,
}: {
  group: GroupWithOptions;
  liveIds: readonly string[];
  archived: boolean;
}) {
  const { menuEditor } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const locale = useLocale();
  const name = localName(locale, group.nameTh, group.nameEn);
  const { live, archived: gone } = optionRowsOf(group);
  const optionIds = live.map((o) => o.id);
  const rowBusy = ctx.pending.includes(rowKey(group.id));
  const listBusy = ctx.pending.includes(reorderKey('groups', undefined));

  return (
    <li className={`mgroup${archived ? ' mgroup--archived' : ''}`}>
      <div className="mrow">
        <span className="mrow__main">
          <span className="mrow__name">{name}</span>
          <span className="mrow__meta">
            <span className="muted">
              {tr('menuEditor.group.range', { min: group.minSelect, max: group.maxSelect })}
            </span>
            {group.minSelect > 0 ? (
              <span className="tag tag--req">{tr('menuEditor.group.required')}</span>
            ) : null}
          </span>
        </span>
        <span className="mrow__actions">
          {archived ? null : (
            <MoveButtons
              ids={liveIds}
              id={group.id}
              name={name}
              disabled={ctx.offline || listBusy}
              onMove={(order) => void ctx.run(menuEditor.reorder('groups', undefined, order))}
            />
          )}
          <RowButtons
            name={name}
            archived={archived}
            disabled={ctx.offline || rowBusy}
            {...(archived ? {} : { onEdit: () => ctx.open({ kind: 'group', id: group.id }) })}
            onArchive={() => void ctx.run(menuEditor.setGroupArchived(group, true))}
            onRestore={() => void ctx.run(menuEditor.setGroupArchived(group, false))}
          />
        </span>
      </div>

      {archived ? null : (
        <>
          {live.length === 0 ? (
            <p className="muted mgroup__empty">{tr('menuEditor.empty.options')}</p>
          ) : (
            <ul className="mlist mlist--nested">
              {live.map((option) => (
                <OptionRow
                  key={option.id}
                  option={option}
                  group={group}
                  liveIds={optionIds}
                  archived={false}
                />
              ))}
            </ul>
          )}
          <div className="mgroup__add">
            <button
              type="button"
              className="btn btn-soft"
              disabled={ctx.offline}
              onClick={() => ctx.open({ kind: 'option', groupId: group.id })}
            >
              <Icon name="plus" />
              <span>{tr('menuEditor.add.option')}</span>
            </button>
          </div>
          {ctx.showArchived && gone.length > 0 ? (
            <ul className="mlist mlist--nested">
              {gone.map((option) => (
                <OptionRow
                  key={option.id}
                  option={option}
                  group={group}
                  liveIds={optionIds}
                  archived
                />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  );
}

/** The modifier groups with their options: noodle type, spice level, extras. */
export function GroupsTab() {
  const tr = useT();
  const ctx = useEditorContext();
  const { live, archived } = groupRows(useEntities());
  const liveIds = live.map((g) => g.id);

  return (
    <div className="medit__panel">
      <div className="medit__bar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'group' })}
        >
          <Icon name="plus" />
          <span>{tr('menuEditor.add.group')}</span>
        </button>
      </div>
      {live.length === 0 ? (
        <p className="muted medit__empty">{tr('menuEditor.empty.groups')}</p>
      ) : (
        <ul className="mlist">
          {live.map((group) => (
            <GroupCard key={group.id} group={group} liveIds={liveIds} archived={false} />
          ))}
        </ul>
      )}
      {ctx.showArchived && archived.length > 0 ? (
        <>
          <h2 className="medit__sub">{tr('menuEditor.archivedHeading')}</h2>
          <ul className="mlist">
            {archived.map((group) => (
              <GroupCard key={group.id} group={group} liveIds={liveIds} archived />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
