import { formatBaht } from '@sds/i18n';
import type { OptionDto } from '@sds/shared';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { localName } from '../pos/names.ts';
import type { GroupWithOptions } from '../realtime/selectors.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { useEditorContext } from './editor-context.ts';
import { groupRows, optionRowsOf } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowBadge, RowButtons, SoldOutSwitch } from './RowParts.tsx';
import './menu-glass.css';

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
    <li className={`g-row merow merow--option${archived ? ' merow--archived' : ''}`}>
      <span className="merow__main">
        <span className="merow__name">{name}</span>
        <span className="merow__meta">
          <span className="merow__price g-num">{delta(option.priceDeltaSatang)}</span>
          {cost === undefined ? null : (
            <span>
              {tr('menuEditor.option.costDelta', {
                amount: `${cost > 0 ? '+' : ''}${formatBaht(cost, locale, { decimals: 'auto' })}`,
              })}
            </span>
          )}
        </span>
        {archived || !option.isAvailable ? (
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
    <li className={`g-glass gset-grp megroup${archived ? ' megroup--archived' : ''}`}>
      <div className={`g-row merow${archived ? ' merow--archived' : ''}`}>
        <span className="merow__main">
          <span className="merow__name">{name}</span>
          <span className="merow__meta">
            <span>
              {tr('menuEditor.group.range', { min: group.minSelect, max: group.maxSelect })}
            </span>
            {group.minSelect > 0 ? (
              <RowBadge tone="info" icon="info">
                {tr('menuEditor.group.required')}
              </RowBadge>
            ) : null}
            {archived ? (
              <RowBadge tone="mute" icon="x">
                {tr('menuEditor.archived')}
              </RowBadge>
            ) : null}
          </span>
        </span>
        <span className="merow__actions">
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
            <p
              className="g-t-s"
              style={s('margin:0;padding:12px 18px;border-top:1px solid var(--hair)')}
            >
              {tr('menuEditor.empty.options')}
            </p>
          ) : (
            <ul className="gset-list">
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
          <div className="megroup__foot">
            <button
              type="button"
              className="g-btn gbtn-row"
              disabled={ctx.offline}
              onClick={() => ctx.open({ kind: 'option', groupId: group.id })}
            >
              <Gi n="plus" size="sm" />
              <span>{tr('menuEditor.add.option')}</span>
            </button>
          </div>
          {ctx.showArchived && gone.length > 0 ? (
            <ul className="gset-list" style={s('border-top:1px solid var(--hair)')}>
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
    <div style={s('display:flex;flex-direction:column;gap:16px;min-width:0')}>
      <div>
        <button
          type="button"
          className="g-btn g-btn-p"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'group' })}
        >
          <Gi n="plus" size="sm" />
          <span>{tr('menuEditor.add.group')}</span>
        </button>
      </div>
      {live.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('menuEditor.empty.groups')}
        </p>
      ) : (
        <ul className="gset-list" style={s('display:flex;flex-direction:column;gap:16px')}>
          {live.map((group) => (
            <GroupCard key={group.id} group={group} liveIds={liveIds} archived={false} />
          ))}
        </ul>
      )}
      {ctx.showArchived && archived.length > 0 ? (
        <>
          <h2 className="gset-lbl" style={s('margin:0;padding-bottom:0')}>
            {tr('menuEditor.archivedHeading')}
          </h2>
          <ul
            className="gset-list"
            style={s('display:flex;flex-direction:column;gap:16px;margin-top:-8px')}
          >
            {archived.map((group) => (
              <GroupCard key={group.id} group={group} liveIds={liveIds} archived />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
