import { formatBaht } from '@sds/i18n';
import type { CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useState } from 'react';
import {
  addLine,
  type Cart,
  estimateTotal,
  groupProblem,
  itemCount,
  selectionIsValid,
  unitEstimate,
} from '../model/cart.ts';
import { clock } from '../model/checkout.ts';
import { useApp, useT } from './app-context.tsx';

type Item = PublicMenuResponse['categories'][number]['items'][number];

export function MenuScreen({
  menu,
  info,
  cart,
  setCart,
}: {
  menu: PublicMenuResponse;
  info: CheckoutInfo | null;
  cart: Cart;
  setCart: (cart: Cart) => void;
}) {
  const tr = useT();
  const { go, locale } = useApp();
  const [picking, setPicking] = useState<Item | null>(null);
  const count = itemCount(cart);
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  return (
    <section aria-labelledby="menu-title">
      <h1 id="menu-title">{tr('liff.menu.title')}</h1>
      <p className="muted">{tr('liff.menu.deliverOnly')}</p>
      {info && !info.delivery.open ? (
        <p className="notice" role="status">
          {info.delivery.window
            ? tr('liff.menu.closed', {
                from: clock(info.delivery.window.openMinute),
                to: clock(info.delivery.window.closeMinute),
              })
            : tr('liff.menu.closedToday')}
        </p>
      ) : null}
      {menu.categories.every((c) => c.items.length === 0) ? (
        <p className="muted">{tr('liff.menu.empty')}</p>
      ) : null}
      {menu.categories
        .filter((c) => c.items.length > 0)
        .map((category) => (
          <div key={category.id}>
            <h2>{name(category)}</h2>
            <ul className="list">
              {category.items.map((item) => (
                <li key={item.id} className="row">
                  <div className="grow">
                    <div className="strong">{name(item)}</div>
                    {item.descriptionTh ? (
                      <div className="muted small">
                        {locale === 'en' && item.descriptionEn
                          ? item.descriptionEn
                          : item.descriptionTh}
                      </div>
                    ) : null}
                    <div>{formatBaht(item.priceSatang, locale)}</div>
                  </div>
                  <button type="button" className="btn" onClick={() => setPicking(item)}>
                    {tr('liff.menu.add')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {count > 0 ? (
        <div className="dock">
          <button type="button" className="btn primary wide" onClick={() => go('/cart')}>
            {tr('liff.menu.cart', {
              count,
              amount: formatBaht(estimateTotal(cart, menu), locale),
            })}
          </button>
        </div>
      ) : null}
      {picking ? (
        <ItemSheet
          item={picking}
          onClose={() => setPicking(null)}
          onAdd={(line) => {
            setCart(addLine(cart, line));
            setPicking(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ItemSheet({
  item,
  onAdd,
  onClose,
}: {
  item: Item;
  onAdd: (line: { menuItemId: string; optionIds: string[]; note: string; qty: number }) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const { locale } = useApp();
  const [picked, setPicked] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  function toggle(groupId: string, optionId: string, single: boolean) {
    const group = item.modifierGroups.find((g) => g.id === groupId);
    if (!group) return;
    const inGroup = group.options.map((o) => o.id);
    setPicked((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      const others = single ? current.filter((id) => !inGroup.includes(id)) : current;
      return [...others, optionId];
    });
  }

  const valid = selectionIsValid(item, picked);
  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={name(item)}>
        <div className="row">
          <h2 className="grow">{name(item)}</h2>
          <button type="button" className="btn" onClick={onClose} aria-label={tr('liff.close')}>
            ✕
          </button>
        </div>
        {item.modifierGroups.map((group) => {
          const single = group.maxSelect === 1;
          const problem = groupProblem(group, picked);
          return (
            <fieldset key={group.id} className="group">
              <legend>
                {name(group)}{' '}
                <span className="muted small">
                  {group.minSelect > 0
                    ? tr('liff.option.required', { min: group.minSelect })
                    : group.maxSelect > 0
                      ? tr('liff.option.max', { max: group.maxSelect })
                      : ''}
                </span>
              </legend>
              {group.options.map((option) => (
                <label key={option.id} className="choice">
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    name={group.id}
                    checked={picked.includes(option.id)}
                    onChange={() => toggle(group.id, option.id, single)}
                  />
                  <span className="grow">{name(option)}</span>
                  {option.priceDeltaSatang !== 0 ? (
                    <span>+{formatBaht(option.priceDeltaSatang, locale)}</span>
                  ) : null}
                </label>
              ))}
              {problem === 'too_many' ? (
                <p className="error" role="alert">
                  {tr('liff.option.max', { max: group.maxSelect })}
                </p>
              ) : null}
            </fieldset>
          );
        })}
        <label className="field">
          <span>{tr('liff.option.note')}</span>
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row">
          <span className="grow">{tr('liff.option.qty')}</span>
          <button
            type="button"
            className="btn"
            aria-label={tr('liff.cart.dec')}
            disabled={qty <= 1}
            onClick={() => setQty(qty - 1)}
          >
            −
          </button>
          <span className="qty" aria-live="polite">
            {qty}
          </span>
          <button
            type="button"
            className="btn"
            aria-label={tr('liff.cart.inc')}
            onClick={() => setQty(Math.min(99, qty + 1))}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="btn primary wide"
          disabled={!valid}
          onClick={() => onAdd({ menuItemId: item.id, optionIds: picked, note, qty })}
        >
          {tr('liff.option.add', {
            amount: formatBaht(unitEstimate(item, picked) * qty, locale),
          })}
        </button>
      </div>
    </div>
  );
}
