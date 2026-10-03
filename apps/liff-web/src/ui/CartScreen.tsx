import { formatBaht } from '@sds/i18n';
import { orderPlacedText } from '@sds/line/order-text';
import type { AppPayMethod, CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useMemo, useRef, useState } from 'react';
import {
  type Cart,
  estimateTotal,
  findItem,
  missingLines,
  setQty,
  toOrderItems,
  unitEstimate,
} from '../model/cart.ts';
import {
  type CheckoutForm,
  createRequestIds,
  formProblems,
  NAME_MAX,
  NOTE_MAX,
  prefilled,
} from '../model/checkout.ts';
import { errorKey, useApp, useT } from './app-context.tsx';

export function CartScreen({
  menu,
  cart,
  setCart,
}: {
  menu: PublicMenuResponse;
  cart: Cart;
  setCart: (cart: Cart) => void;
}) {
  const tr = useT();
  const { go, locale } = useApp();
  const gone = missingLines(cart, menu);
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  return (
    <section aria-labelledby="cart-title">
      <h1 id="cart-title">{tr('liff.cart.title')}</h1>
      {cart.length === 0 ? <p className="muted">{tr('liff.cart.empty')}</p> : null}
      <ul className="list">
        {cart.map((line) => {
          const item = findItem(menu, line.menuItemId);
          if (!item) return null;
          const options = item.modifierGroups
            .flatMap((g) => g.options)
            .filter((o) => line.optionIds.includes(o.id));
          return (
            <li key={line.key} className="row">
              <div className="grow">
                <div className="strong">{name(item)}</div>
                {options.length > 0 ? (
                  <div className="muted small">{options.map(name).join(', ')}</div>
                ) : null}
                {line.note ? <div className="muted small">“{line.note}”</div> : null}
                <div>{formatBaht(unitEstimate(item, line.optionIds) * line.qty, locale)}</div>
              </div>
              <button
                type="button"
                className="btn"
                aria-label={tr('liff.cart.dec')}
                onClick={() => setCart(setQty(cart, line.key, line.qty - 1))}
              >
                −
              </button>
              <span className="qty">{line.qty}</span>
              <button
                type="button"
                className="btn"
                aria-label={tr('liff.cart.inc')}
                onClick={() => setCart(setQty(cart, line.key, line.qty + 1))}
              >
                +
              </button>
            </li>
          );
        })}
      </ul>
      {gone.length > 0 ? (
        <div className="error" role="alert">
          <p>{tr('liff.error.ORDER_INVALID')}</p>
          <button
            type="button"
            className="btn"
            onClick={() => setCart(cart.filter((l) => !gone.some((g) => g.key === l.key)))}
          >
            {tr('liff.cart.remove')}
          </button>
        </div>
      ) : null}
      {cart.length > 0 && gone.length === 0 ? (
        <div className="dock">
          <p className="muted small">
            {tr('liff.cart.estimate', { amount: formatBaht(estimateTotal(cart, menu), locale) })}
          </p>
          <button type="button" className="btn primary wide" onClick={() => go('/checkout')}>
            {tr('liff.cart.checkout')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function CheckoutScreen({
  menu,
  info,
  cart,
  clearCart,
  refreshInfo,
}: {
  menu: PublicMenuResponse;
  info: CheckoutInfo;
  cart: Cart;
  clearCart: () => void;
  refreshInfo: () => Promise<void>;
}) {
  const tr = useT();
  const { api, platform, go, locale } = useApp();
  const [form, setForm] = useState<CheckoutForm>(() => prefilled(info));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestIds()).current;
  const problems = formProblems(form, info);
  const [tried, setTried] = useState(false);

  const last = info.lastRecipient;
  const signature = useMemo(
    () =>
      JSON.stringify([
        toOrderItems(cart),
        form.building,
        form.name.trim(),
        form.note.trim(),
        form.method,
      ]),
    [cart, form],
  );

  if (!info.privacyAcknowledged) {
    return <PrivacyGate refreshInfo={refreshInfo} />;
  }

  async function submit() {
    setTried(true);
    if (problems.length > 0 || busy || form.method === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.placeOrder({
        clientRequestId: requests.forSignature(signature),
        items: toOrderItems(cart),
        deliveryBuilding: form.building,
        recipientName: form.name.trim(),
        ...(form.note.trim() ? { deliveryNote: form.note.trim() } : {}),
        paymentMethod: form.method,
      });
      requests.reset();
      clearCart();
      if (platform.canSendMessages()) void platform.sendText(orderPlacedText(result.order.orderNo));
      go(`/orders/${result.order.id}${result.paymentError ? '?payment=failed' : '?placed=1'}`, {
        replace: true,
      });
    } catch (e) {
      // The same request id stays, so pressing the button again can never make a second order.
      setError(tr(errorKey(e)));
      setBusy(false);
    }
  }

  const methods: AppPayMethod[] = info.methods;
  return (
    <section aria-labelledby="checkout-title">
      <h1 id="checkout-title">{tr('liff.checkout.title')}</h1>
      <p className="muted">{tr('liff.checkout.handover')}</p>
      {last ? (
        <button
          type="button"
          className="btn wide"
          onClick={() => setForm({ ...form, ...prefilled(info), method: form.method })}
        >
          {tr('liff.checkout.prefill', { building: last.building, name: last.recipientName })}
        </button>
      ) : null}
      <label className="field">
        <span>{tr('liff.checkout.building')}</span>
        <select
          value={form.building}
          onChange={(e) => setForm({ ...form, building: e.target.value })}
        >
          <option value="">{tr('liff.checkout.buildingPick')}</option>
          {info.buildings.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{tr('liff.checkout.name')}</span>
        <input
          value={form.name}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{tr('liff.checkout.note')}</span>
        <input
          value={form.note}
          maxLength={NOTE_MAX}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </label>
      <fieldset className="group">
        <legend>{tr('liff.checkout.payment')}</legend>
        {methods.map((method) => (
          <label key={method} className="choice">
            <input
              type="radio"
              name="method"
              checked={form.method === method}
              onChange={() => setForm({ ...form, method })}
            />
            <span className="grow">{tr(`liff.checkout.method.${method}`)}</span>
          </label>
        ))}
      </fieldset>
      {(tried && problems.includes('building')) || (tried && problems.includes('name')) ? (
        <p className="error" role="alert">
          {tr('liff.checkout.required')}
        </p>
      ) : null}
      {problems.includes('closed') ? (
        <p className="notice">{tr('liff.error.SHOP_CLOSED')}</p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dock">
        <button
          type="button"
          className="btn primary wide"
          disabled={busy || problems.includes('closed')}
          aria-busy={busy}
          onClick={() => void submit()}
        >
          {busy
            ? tr('liff.checkout.placing')
            : tr('liff.checkout.place', { amount: formatBaht(estimateTotal(cart, menu), locale) })}
        </button>
      </div>
    </section>
  );
}

function PrivacyGate({ refreshInfo }: { refreshInfo: () => Promise<void> }) {
  const tr = useT();
  const { api } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="privacy-title">
      <h1 id="privacy-title">{tr('liff.privacy.title')}</h1>
      <p>{tr('liff.privacy.body')}</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.acknowledgePrivacy();
            await refreshInfo();
          } catch (e) {
            setError(tr(errorKey(e)));
            setBusy(false);
          }
        }}
      >
        {tr('liff.privacy.accept')}
      </button>
    </section>
  );
}
