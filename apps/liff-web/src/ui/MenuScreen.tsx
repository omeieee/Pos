import { formatBaht } from '@sds/i18n';
import type { CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useEffect, useRef, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import {
  addLine,
  type Cart,
  estimateTotal,
  groupProblem,
  itemCount,
  selectionIsValid,
  setQty,
  unitEstimate,
} from '../model/cart.ts';
import { clock } from '../model/checkout.ts';
import { shopPhoneOf, telHref } from '../model/contact.ts';
import { useApp, useT } from './app-context.tsx';
import { BarButton, Body, Dock, Header, Notice } from './Chrome.tsx';
import { DishThumb } from './DishThumb.tsx';

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
  const { go, locale, platform } = useApp();
  const [picking, setPicking] = useState<Item | null>(null);
  const [category, setCategory] = useState('all');
  const [more, setMore] = useState(false);
  const count = itemCount(cart);
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  const categories = menu.categories.filter((c) => c.items.length > 0);
  const active = categories.some((c) => c.id === category) ? category : 'all';
  const shown = categories
    .filter((c) => active === 'all' || c.id === active)
    .flatMap((c) => c.items);
  const delivery = info?.delivery;

  function linesOf(item: Item) {
    return cart.filter((l) => l.menuItemId === item.id);
  }
  function add(item: Item) {
    if (item.modifierGroups.length > 0) setPicking(item);
    else setCart(addLine(cart, { menuItemId: item.id, optionIds: [], qty: 1 }));
  }
  function plus(item: Item) {
    const last = linesOf(item).at(-1);
    if (item.modifierGroups.length > 0 || !last) setPicking(item);
    else setCart(setQty(cart, last.key, last.qty + 1));
  }
  function minus(item: Item) {
    const last = linesOf(item).at(-1);
    if (last) setCart(setQty(cart, last.key, last.qty - 1));
  }

  return (
    <>
      <Header
        left={<BarButton icon="x" label={tr('liff.close')} onClick={() => platform.close()} />}
        title={tr('liff.app.name')}
        right={
          <BarButton
            icon="more"
            label={tr('liff.menu.more')}
            expanded={more}
            onClick={() => setMore((v) => !v)}
          />
        }
      >
        <div
          className="g-glass g-rise"
          style={s(
            'border-radius:28px;padding:14px 16px;display:flex;gap:14px;align-items:center;--d:.04s',
          )}
        >
          <div
            className="g-ico"
            aria-hidden="true"
            style={s(
              'width:46px;height:46px;border-radius:16px;background:linear-gradient(180deg,#d63a2e,#bd2424)',
            )}
          >
            <Gi n="building" />
          </div>
          <div style={s('flex-grow:1;min-width:0;line-height:1.4')}>
            <div className="g-t-3">{tr('liff.menu.deliverTitle')}</div>
            <div className="g-t-s">{tr('liff.menu.deliverSub')}</div>
          </div>
          {delivery?.open && delivery.window ? (
            <span className="g-badge g-b-ok">
              <span className="g-dot" style={s('width:7px;height:7px')} />
              {tr('liff.menu.until', { time: clock(delivery.window.closeMinute) })}
            </span>
          ) : delivery && !delivery.open ? (
            <span className="g-badge g-b-warn">
              <Gi n="pending" />
              {tr('liff.menu.closedBadge')}
            </span>
          ) : null}
        </div>
        {categories.length > 1 ? (
          <div
            role="radiogroup"
            aria-label={tr('liff.menu.categories')}
            className="g-scroll"
            style={s('display:flex;gap:8px;margin:0 -14px;padding:0 14px;flex:none')}
          >
            <label className="g-chip">
              <input
                type="radio"
                name="category"
                checked={active === 'all'}
                onChange={() => setCategory('all')}
              />
              {tr('liff.menu.all')}
            </label>
            {categories.map((c) => (
              <label key={c.id} className="g-chip">
                <input
                  type="radio"
                  name="category"
                  checked={active === c.id}
                  onChange={() => setCategory(c.id)}
                />
                {name(c)}
              </label>
            ))}
          </div>
        ) : null}
      </Header>

      {more ? <MoreMenu tel={telHref(shopPhoneOf(info))} onClose={() => setMore(false)} /> : null}

      <Body label={tr('liff.menu.title')} bottom={count > 0 ? 132 : 28} fade={count > 0 ? 170 : 0}>
        {info && !info.delivery.open ? (
          <div style={s('margin-bottom:12px')}>
            <Notice tone="warn" icon="clock">
              {info.delivery.mode === 'closed'
                ? tr('liff.menu.paused')
                : info.delivery.window
                  ? tr('liff.menu.closed', {
                      from: clock(info.delivery.window.openMinute),
                      to: clock(info.delivery.window.closeMinute),
                    })
                  : tr('liff.menu.closedToday')}
            </Notice>
          </div>
        ) : null}
        {categories.length === 0 ? (
          <p className="g-t-s" role="status" style={s('margin:8px 10px')}>
            {tr('liff.menu.empty')}
          </p>
        ) : null}
        <ul
          style={s(
            'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px',
          )}
        >
          {shown.map((item, index) => {
            const qty = linesOf(item).reduce((sum, l) => sum + l.qty, 0);
            const label = name(item);
            return (
              <li
                key={item.id}
                className="dish g-glass g-rise"
                style={{ ['--d' as string]: `${Math.min(0.08 + index * 0.04, 0.4)}s` }}
              >
                <DishThumb item={item} box={92} art={78} radius={24} />
                <div
                  style={s('flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:3px')}
                >
                  <h2 className="g-t-3 g-clamp2" style={s('font-size:16px;margin:0')}>
                    <button type="button" className="dish-open" onClick={() => setPicking(item)}>
                      {label}
                    </button>
                  </h2>
                  {item.descriptionTh ? (
                    <div className="g-t-c g-clamp2" style={s('font-weight:400')}>
                      {locale === 'en' && item.descriptionEn
                        ? item.descriptionEn
                        : item.descriptionTh}
                    </div>
                  ) : null}
                  <div
                    style={s(
                      'display:flex;align-items:center;justify-content:space-between;padding-top:4px',
                    )}
                  >
                    <span className="g-num g-t-2">
                      {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
                    </span>
                    {qty > 0 ? (
                      <div className="g-step">
                        <button
                          type="button"
                          aria-label={`${tr('liff.cart.dec')} ${label}`}
                          onClick={() => minus(item)}
                        >
                          <Gi n="minus" size="sm" />
                        </button>
                        <b aria-live="polite">{qty}</b>
                        <button
                          type="button"
                          aria-label={`${tr('liff.cart.inc')} ${label}`}
                          onClick={() => plus(item)}
                        >
                          <Gi n="plus" size="sm" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="g-add"
                        aria-label={`${tr('liff.menu.add')} ${label}`}
                        onClick={() => add(item)}
                      >
                        <Gi n="plus" size="sm" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Body>

      {count > 0 ? (
        <Dock
          label={tr('liff.menu.cart', {
            count,
            amount: formatBaht(estimateTotal(cart, menu), locale),
          })}
          style={s('height:68px;border-radius:34px;padding:0 10px 0 18px')}
        >
          <div
            aria-hidden="true"
            style={s(
              'width:40px;height:40px;border-radius:50%;background:rgba(198,40,40,.12);color:var(--chili);display:grid;place-items:center;flex:none',
            )}
          >
            <Gi n="bag" />
          </div>
          <div style={s('flex-grow:1;min-width:0;line-height:1.3')}>
            <div className="g-t-c">{tr('liff.menu.cartCount', { count })}</div>
            <div className="g-num g-t-2">{formatBaht(estimateTotal(cart, menu), locale)}</div>
          </div>
          <button type="button" className="g-btn g-btn-p" onClick={() => go('/checkout')}>
            {tr('liff.menu.toPay')}
            <Gi n="chevronRight" size="sm" />
          </button>
        </Dock>
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
    </>
  );
}

/** The "more" menu under the header bar: the way to the customer's own orders. */
function MoreMenu({ tel, onClose }: { tel: string | null; onClose: () => void }) {
  const tr = useT();
  const { go } = useApp();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        style={s('position:absolute;inset:0;z-index:28;background:transparent;border:0;padding:0')}
      />
      <div
        role="menu"
        className="g-glass2 g-pop"
        style={s(
          'position:absolute;z-index:29;right:20px;top:calc(env(safe-area-inset-top, 0px) + 72px);border-radius:22px;padding:6px;min-width:200px',
        )}
      >
        <button
          type="button"
          role="menuitem"
          className="g-side"
          style={s(
            'width:100%;border:0;background:transparent;font-family:inherit;text-align:left',
          )}
          onClick={() => {
            onClose();
            go('/orders');
          }}
        >
          <Gi n="receipt" />
          {tr('liff.nav.orders')}
        </button>
        {tel ? (
          <a role="menuitem" className="g-side" href={tel} style={s('text-decoration:none')}>
            <Gi n="phone" />
            {tr('liff.contact.call')}
          </a>
        ) : null}
      </div>
    </>
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
  const sheet = useRef<HTMLDivElement>(null);
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div className="overlay liff-overlay" role="presentation">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="liff-scrim"
        onClick={onClose}
      />
      <div
        ref={sheet}
        tabIndex={-1}
        className="sheet sheet--options liff-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-title"
      >
        <header style={s('display:flex;align-items:flex-start;gap:12px;flex:none')}>
          <div style={s('flex-grow:1;min-width:0')}>
            <h2 id="item-title" className="g-t-1" style={s('margin:0')}>
              {name(item)}{' '}
              <span className="g-num" style={s('color:var(--ink2)')}>
                {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
              </span>
            </h2>
          </div>
          <button
            type="button"
            className="g-btn g-btn-icon"
            aria-label={tr('liff.close')}
            onClick={onClose}
          >
            <Gi n="x" />
          </button>
        </header>

        <div
          className="g-scroll"
          style={s('flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:16px')}
        >
          {item.modifierGroups.map((group) => {
            const single = group.maxSelect === 1;
            const problem = groupProblem(group, picked);
            return (
              <fieldset
                key={group.id}
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
                  {name(group)}
                  {group.minSelect > 0 || group.maxSelect > 0 ? (
                    <span
                      className={`g-badge ${group.minSelect > 0 ? 'g-b-bad' : 'g-b-mute'}`}
                      style={s('height:24px;padding:0 10px;font-size:12px')}
                    >
                      {group.minSelect > 0
                        ? tr('liff.option.required', { min: group.minSelect })
                        : tr('liff.option.max', { max: group.maxSelect })}
                    </span>
                  ) : null}
                </legend>
                <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
                  {group.options.map((option) => {
                    const on = picked.includes(option.id);
                    return (
                      <label key={option.id} className={`g-chip${on ? ' g-on' : ''}`}>
                        <input
                          type={single ? 'radio' : 'checkbox'}
                          name={group.id}
                          checked={on}
                          onChange={() => toggle(group.id, option.id, single)}
                        />
                        {on ? <Gi n="check" size="sm" /> : null}
                        <span>{name(option)}</span>
                        {option.priceDeltaSatang !== 0 ? (
                          <span className="g-num" style={s('opacity:.8')}>
                            +{formatBaht(option.priceDeltaSatang, locale, { decimals: 'auto' })}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                {problem === 'too_many' ? (
                  <Notice tone="bad" icon="warn" alert>
                    {tr('liff.option.max', { max: group.maxSelect })}
                  </Notice>
                ) : null}
              </fieldset>
            );
          })}
          <div style={s('display:flex;flex-direction:column;gap:6px')}>
            <label className="g-t-3" htmlFor="line-note" style={s('font-size:15px')}>
              {tr('liff.option.note')}
            </label>
            <div className="g-field" style={s('height:46px;border-radius:14px;font-size:16px')}>
              <Gi n="note" size="sm" />
              <input
                id="line-note"
                type="text"
                value={note}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </div>

        <footer style={s('flex:none;display:flex;align-items:center;gap:12px')}>
          <fieldset
            className="g-step"
            aria-label={tr('liff.option.qty')}
            style={s('border:0;margin:0;min-width:0')}
          >
            <button
              type="button"
              aria-label={tr('liff.cart.dec')}
              disabled={qty <= 1}
              onClick={() => setQty(qty - 1)}
            >
              <Gi n="minus" size="sm" />
            </button>
            <b aria-live="polite">{qty}</b>
            <button
              type="button"
              aria-label={tr('liff.cart.inc')}
              onClick={() => setQty(Math.min(99, qty + 1))}
            >
              <Gi n="plus" size="sm" />
            </button>
          </fieldset>
          <button
            type="button"
            className="g-btn g-btn-p g-btn-lg"
            style={s('flex:1')}
            disabled={!valid}
            onClick={() => onAdd({ menuItemId: item.id, optionIds: picked, note, qty })}
          >
            {tr('liff.option.add', {
              amount: formatBaht(unitEstimate(item, picked) * qty, locale),
            })}
          </button>
        </footer>
      </div>
    </div>
  );
}
