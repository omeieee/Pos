import { formatBaht } from '@sds/i18n';
import { useEffect, useMemo, useState } from 'react';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
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
      <header className="osheet__head">
        <div>
          <div className="hint">
            {tr(target.mode === 'add' ? 'pos.orderEntry.addToOrder' : 'pos.modifier.editTitle')}
          </div>
          <h2 id="options-title" className="sheet__title">
            {name}{' '}
            <span className="muted money">
              {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
            </span>
          </h2>
        </div>
        <button
          type="button"
          className="btn btn-soft"
          aria-label={tr('common.close')}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </header>

      <div className="osheet__body">
        {item.groups.map((group) => (
          <OptionGroup
            key={group.id}
            group={group}
            selected={optionIds.filter((id) => group.options.some((o) => o.id === id))}
            onChoose={(optionId) => choose(group, optionId)}
          />
        ))}
        <div className="field-group">
          <label className="label" htmlFor="line-note">
            {tr('common.note')}
          </label>
          <input
            id="line-note"
            className="input"
            type="text"
            maxLength={200}
            autoComplete="off"
            placeholder={tr('pos.modifier.lineNotePlaceholder')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <footer className="osheet__foot">
        {missing.length > 0 ? (
          <p className="hint" role="status">
            {tr('pos.modifier.missing', { group: missing.join(', ') })}
          </p>
        ) : null}
        <div className="osheet__actions">
          <div className="stepper">
            <button
              type="button"
              className="btn"
              aria-label={tr('pos.orderEntry.decrease', { name })}
              disabled={qty <= 1}
              onClick={() => setQty((q) => Math.max(1, q - 1))}
            >
              <Icon name="minus" />
            </button>
            <span className="qty" aria-live="polite">
              {qty}
            </span>
            <button
              type="button"
              className="btn"
              aria-label={tr('pos.orderEntry.increase', { name })}
              disabled={qty >= MAX_QTY}
              onClick={() => setQty((q) => Math.min(MAX_QTY, q + 1))}
            >
              <Icon name="plus" />
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-lg osheet__confirm"
            disabled={!check.ok}
            onClick={confirm}
          >
            {tr(target.mode === 'add' ? 'pos.modifier.add' : 'pos.modifier.save', { amount })}
          </button>
        </div>
      </footer>
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
    <fieldset className="group">
      <legend className="group-title">
        {localName(locale, group.nameTh, group.nameEn)}
        <span className={rule.required ? 'tag tag--req' : 'tag'}>{tr(rule.key, rule.params)}</span>
      </legend>
      <div className="picks">
        {group.options.map((option) => {
          const on = selected.includes(option.id);
          const locked = isOptionLocked(group, selected, option.id);
          return (
            <label
              key={option.id}
              className={`pick${on ? ' pick--on' : ''}${locked ? ' pick--locked' : ''}`}
            >
              {/* A native radio or checkbox: arrow keys, Space and the screen reader come for free.
                  The tap is read from onClick so that tapping a chosen radio again can clear an
                  optional choice (onChange does not fire for a radio that is already on). */}
              <input
                className="visually-hidden"
                type={single ? 'radio' : 'checkbox'}
                name={group.id}
                checked={on}
                disabled={locked}
                onChange={() => undefined}
                onClick={() => onChoose(option.id)}
              />
              {on ? <Icon name="check" /> : null}
              <span>{localName(locale, option.nameTh, option.nameEn)}</span>
              {!option.available ? (
                <span className="pick__flag">{tr('pos.orderEntry.soldOut')}</span>
              ) : option.priceDeltaSatang > 0 ? (
                <span className="money">
                  {tr('pos.modifier.priceUp', {
                    amount: formatBaht(option.priceDeltaSatang, locale, { decimals: 'auto' }),
                  })}
                </span>
              ) : option.priceDeltaSatang < 0 ? (
                <span className="money">
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
