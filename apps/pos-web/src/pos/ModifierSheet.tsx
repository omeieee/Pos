import { formatBaht } from '@sds/i18n';
import { useEffect, useMemo, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { checkSelection, estimateLineTotal } from './cart-pricing.ts';
import type { CartMode } from './cart-store.ts';
import type { MenuGroupView, MenuItemView } from './menu-model.ts';
import { localName } from './names.ts';
import { groupRule, isOptionLocked, pruneSelection, toggleOption } from './selection.ts';
import { useCart } from './use-cart.ts';

export type SheetTarget = { mode: 'add'; itemId: string } | { mode: 'edit'; lineKey: string };

const MAX_QTY = 99;

/**
 * The options of one dish: required and optional groups with their min/max honoured, a note and
 * a quantity. iPad: a card over the page; iPhone: a sheet from the bottom (CSS). The "add" button
 * shows an ESTIMATE of the line; it stays off until the shared rules accept the choices.
 */
export function ModifierSheet({
  target,
  item,
  onClose,
  mode = 'storefront',
}: {
  target: SheetTarget;
  item: MenuItemView;
  onClose: () => void;
  mode?: CartMode;
}) {
  const cart = useCart(mode);
  const entities = useEntities();
  const tr = useT();
  const locale = useLocale();

  const initial = useMemo(() => {
    if (target.mode === 'edit') {
      const line = cart.getState().lines.find((l) => l.key === target.lineKey);
      return line
        ? { optionIds: [...line.optionIds], qty: line.qty, note: line.note }
        : { optionIds: [], qty: 1, note: '' };
    }
    return {
      optionIds: pruneSelection(item.groups, cart.lastChoice(item.id) ?? []),
      qty: 1,
      note: '',
    };
  }, [target, cart, item.groups, item.id]);

  const [optionIds, setOptionIds] = useState<string[]>(initial.optionIds);
  const [qty, setQty] = useState(initial.qty);
  const [note, setNote] = useState(initial.note);

  // The line the sheet edits can disappear (another tap, a sign-out): close instead of editing nothing.
  const lineGone =
    target.mode === 'edit' && !cart.getState().lines.some((l) => l.key === target.lineKey);
  useEffect(() => {
    if (lineGone) onClose();
  }, [lineGone, onClose]);
  if (lineGone) return null;

  const { channel } = cart.getState();
  const check = checkSelection(entities, item.id, optionIds, channel);
  const amount = formatBaht(
    estimateLineTotal(entities, { itemId: item.id, optionIds, qty }, channel),
    locale,
  );
  const name = localName(locale, item.nameTh, item.nameEn);
  const missing = item.groups
    .filter((g) => check.missingGroupIds.includes(g.id))
    .map((g) => localName(locale, g.nameTh, g.nameEn));

  function choose(group: MenuGroupView, optionId: string) {
    // Rebuilt group by group, so the choices stay in the order the dish lists its groups.
    setOptionIds((current) =>
      item.groups.flatMap((g) => {
        const own = current.filter((id) => g.options.some((o) => o.id === id));
        return g.id === group.id ? toggleOption(group, own, optionId) : own;
      }),
    );
  }

  function confirm() {
    if (!check.ok) return;
    if (target.mode === 'add') cart.addItem({ itemId: item.id, optionIds, qty, note: note.trim() });
    else cart.updateLine(target.lineKey, { optionIds, qty, note: note.trim() });
    onClose();
  }

  return (
    <Modal labelledBy="options-title" onClose={onClose} variant="options">
      <div
        style={s(
          'display:flex;flex-direction:column;gap:16px;padding:24px 24px calc(22px + env(safe-area-inset-bottom, 0px));min-height:0',
        )}
      >
        <header style={s('display:flex;align-items:flex-start;gap:12px;flex:none')}>
          <div style={s('flex-grow:1;min-width:0')}>
            <div className="g-t-c">
              {tr(target.mode === 'add' ? 'pos.orderEntry.addToOrder' : 'pos.modifier.editTitle')}
            </div>
            <h2 id="options-title" className="g-t-1" style={s('margin:0')}>
              {name}{' '}
              <span className="g-num" style={s('color:var(--ink2)')}>
                {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
              </span>
            </h2>
          </div>
          <button
            type="button"
            className="g-btn g-btn-icon"
            aria-label={tr('common.close')}
            onClick={onClose}
          >
            <Gi n="x" />
          </button>
        </header>

        <div
          className="g-scroll"
          style={s('flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:16px')}
        >
          {item.groups.map((group) => (
            <OptionGroup
              key={group.id}
              group={group}
              selected={optionIds.filter((id) => group.options.some((o) => o.id === id))}
              onChoose={(optionId) => choose(group, optionId)}
            />
          ))}
          <div style={s('display:flex;flex-direction:column;gap:6px')}>
            <label className="g-t-3" htmlFor="line-note" style={s('font-size:15px')}>
              {tr('common.note')}
            </label>
            <div className="g-field" style={s('height:46px;border-radius:14px;font-size:14px')}>
              <Gi n="note" size="sm" />
              <input
                id="line-note"
                type="text"
                maxLength={200}
                autoComplete="off"
                placeholder={tr('pos.modifier.lineNotePlaceholder')}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        </div>

        <footer
          style={s(
            'flex:none;display:flex;flex-direction:column;gap:10px;position:sticky;bottom:0',
          )}
        >
          {missing.length > 0 ? (
            <p className="g-t-c" role="status" style={s('margin:0')}>
              {tr('pos.modifier.missing', { group: missing.join(', ') })}
            </p>
          ) : null}
          <div style={s('display:flex;align-items:center;gap:12px')}>
            <div className="g-step">
              <button
                type="button"
                aria-label={tr('pos.orderEntry.decrease', { name })}
                disabled={qty <= 1}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                <Gi n="minus" size="sm" />
              </button>
              <b aria-live="polite">{qty}</b>
              <button
                type="button"
                aria-label={tr('pos.orderEntry.increase', { name })}
                disabled={qty >= MAX_QTY}
                onClick={() => setQty((q) => Math.min(MAX_QTY, q + 1))}
              >
                <Gi n="plus" size="sm" />
              </button>
            </div>
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg"
              style={s('flex:1')}
              disabled={!check.ok}
              onClick={confirm}
            >
              {tr(target.mode === 'add' ? 'pos.modifier.add' : 'pos.modifier.save', { amount })}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}

function OptionGroup({
  group,
  selected,
  onChoose,
}: {
  group: MenuGroupView;
  selected: readonly string[];
  onChoose: (optionId: string) => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const rule = groupRule(group);
  const single = group.maxSelect === 1;
  return (
    <fieldset
      style={s(
        'border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:10px',
      )}
    >
      <legend
        className="g-t-3"
        style={s(
          'font-size:15px;padding:0;margin-bottom:10px;display:flex;align-items:center;gap:8px',
        )}
      >
        {localName(locale, group.nameTh, group.nameEn)}
        <span
          className={`g-badge ${rule.required ? 'g-b-bad' : 'g-b-mute'}`}
          style={s('height:24px;padding:0 10px;font-size:12px')}
        >
          {tr(rule.key, rule.params)}
        </span>
      </legend>
      <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
        {group.options.map((option) => {
          const on = selected.includes(option.id);
          const locked = isOptionLocked(group, selected, option.id);
          return (
            <label
              key={option.id}
              className={`g-chip${on ? ' g-on' : ''}`}
              style={s(`gap:6px;${locked || !option.available ? 'opacity:.5;' : ''}`)}
            >
              {/* A native radio or checkbox: arrow keys, Space and the screen reader come for free.
                  The tap is read from onClick so that tapping a chosen radio again can clear an
                  optional choice (onChange does not fire for a radio that is already on). */}
              <input
                type={single ? 'radio' : 'checkbox'}
                name={group.id}
                checked={on}
                disabled={locked}
                onChange={() => undefined}
                onClick={() => onChoose(option.id)}
              />
              {on ? <Gi n="check" size="sm" /> : null}
              <span>{localName(locale, option.nameTh, option.nameEn)}</span>
              {!option.available ? (
                <span
                  className="g-badge g-b-bad"
                  style={s('height:22px;padding:0 8px;font-size:12px')}
                >
                  {tr('pos.orderEntry.soldOut')}
                </span>
              ) : option.priceDeltaSatang > 0 ? (
                <span className="g-num g-t-c" style={s('color:inherit;opacity:.8')}>
                  {tr('pos.modifier.priceUp', {
                    amount: formatBaht(option.priceDeltaSatang, locale, { decimals: 'auto' }),
                  })}
                </span>
              ) : option.priceDeltaSatang < 0 ? (
                <span className="g-num g-t-c" style={s('color:inherit;opacity:.8')}>
                  {formatBaht(option.priceDeltaSatang, locale, { decimals: 'auto' })}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
