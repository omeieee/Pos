import { formatBaht } from '@sds/i18n';
import { orderPlacedText } from '@sds/line/order-text';
import type { AppOrderInput, CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { useMemo, useRef, useState } from 'react';
import { ApiFailure } from '../api/client.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { type Cart, estimateTotal, findItem, toOrderItems, unitEstimate } from '../model/cart.ts';
import { removeLines, type UnavailableLine, unavailableLines } from '../model/cart-recovery.ts';
import {
  type CheckoutForm,
  createRequestIds,
  formProblems,
  NAME_MAX,
  NOTE_MAX,
  prefilled,
} from '../model/checkout.ts';
import {
  type CheckoutWarning,
  checkoutWarning,
  type EditSession,
  mergedItems,
} from '../model/open-orders.ts';
import { errorKey, useApp, useT } from './app-context.tsx';
import { BarButton, Body, Dock, Header, Notice, SectionLabel } from './Chrome.tsx';
import { DishThumb } from './DishThumb.tsx';
import { OpenOrderSheet } from './order/sheets.tsx';
import { METHOD_ORDER, PayRadio } from './PayOption.tsx';

/**
 * Cart and checkout in one screen (the "ชำระเงิน" board): what you ordered, who gets it at the
 * building entrance, how you pay. Quantities are changed on the menu; the total in the bar is an
 * estimate until the shop prices the order.
 */
export function CheckoutScreen({
  menu,
  info,
  cart,
  setCart,
  clearCart,
  refreshInfo,
  editing = null,
  endEdit = () => {},
  refreshMenu = async () => {},
}: {
  menu: PublicMenuResponse;
  info: CheckoutInfo;
  cart: Cart;
  setCart: (cart: Cart) => void;
  clearCart: () => void;
  refreshInfo: () => Promise<void>;
  /** Set while the customer changes an unpaid order: this screen then saves the lines, nothing else. */
  editing?: EditSession | null;
  /** Leaves the change: puts back the cart the customer had before. */
  endEdit?: () => void;
  /** Reads the menu again (after the server said a dish is no longer available). */
  refreshMenu?: () => Promise<void>;
}) {
  const tr = useT();
  const { api, platform, go, locale } = useApp();
  const [form, setForm] = useState<CheckoutForm>(() => prefilled(info));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestIds()).current;
  const problems = formProblems(form, info);
  const [tried, setTried] = useState(false);
  /** Lines the server refused (a dish that went หมด), named from the menu the customer saw. */
  const [refused, setRefused] = useState<UnavailableLine[]>([]);
  /** The unpaid-order question: which order, and which of its two steps is showing. */
  const [asking, setAsking] = useState<{ step: 'ask' | 'choose'; warning: CheckoutWarning } | null>(
    null,
  );
  const nameField = useRef<HTMLInputElement>(null);
  const buildingField = useRef<HTMLSelectElement>(null);

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
  const name = (n: { nameTh: string; nameEn: string | null }) =>
    locale === 'en' && n.nameEn ? n.nameEn : n.nameTh;

  if (!info.privacyAcknowledged) {
    return <PrivacyGate refreshInfo={refreshInfo} />;
  }

  const unavailable = unavailableLines(cart, menu, [], refused);
  const total = formatBaht(estimateTotal(cart, menu), locale);
  const methods = METHOD_ORDER.filter((m) => info.methods.includes(m));

  async function submit() {
    setTried(true);
    if (problems.includes('building') || problems.includes('name')) {
      // Take the person to the first field that needs filling in.
      const field = problems.includes('name') ? nameField.current : buildingField.current;
      field?.focus();
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    if (problems.length > 0 || busy || form.method === '') return;
    setBusy(true);
    setError(null);
    // An unpaid order of this customer is asked about first (in the app, never in the chat). If
    // the list cannot be read the order goes on as usual: the warning is a help, not a gate.
    let warning: CheckoutWarning | null = null;
    try {
      warning = checkoutWarning((await api.openOrders()).orders, cart, {
        building: form.building,
        name: form.name.trim(),
      });
    } catch {
      warning = null;
    }
    if (warning) {
      setAsking({ step: 'ask', warning });
      setBusy(false);
      return;
    }
    await place();
  }

  async function place() {
    if (form.method === '') return;
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
      failed(e, true);
      setBusy(false);
    }
  }

  /**
   * A refused order. ORDER_INVALID (LINE-02): the lines the server named are shown with a remove
   * action and the menu is read again, so a dish that went หมด shows as gone. Any other error: its
   * text. `fromCart`: the request's lines were the cart's, in order, so the indexes match.
   */
  function failed(e: unknown, fromCart: boolean) {
    if (e instanceof ApiFailure && e.code === 'ORDER_INVALID') {
      const named = fromCart ? unavailableLines(cart, menu, e.lines, refused) : [];
      setRefused(named);
      setError(named.length > 0 ? null : tr(errorKey(e)));
      void refreshMenu().catch(() => undefined);
      return;
    }
    setError(tr(errorKey(e)));
  }

  function removeUnavailable(key: string) {
    setCart(removeLines(cart, [key]));
    setRefused(refused.filter((l) => l.key !== key));
    setError(null);
  }

  /** Replace the lines of an unpaid order. No chat message: this is not a new order. */
  async function saveLines(
    order: { id: string; version: number },
    items: AppOrderInput['items'],
    fromCart = false,
  ) {
    setBusy(true);
    setError(null);
    try {
      const body = { expectedVersion: order.version, items };
      const key = requests.forSignature(JSON.stringify(['edit', order.id, order.version, items]));
      await api.editOrder(order.id, body, key);
      requests.reset();
      if (editing) endEdit();
      else clearCart();
      go(`/orders/${order.id}`, { replace: true });
    } catch (e) {
      failed(e, fromCart);
      setBusy(false);
      setAsking(null);
    }
  }

  const back = <BarButton icon="chevronLeft" label={tr('liff.back')} onClick={() => go('/menu')} />;
  const title = editing
    ? tr('liff.edit.title', { orderNo: editing.orderNo })
    : tr('liff.checkout.title');

  if (cart.length === 0) {
    return (
      <>
        <Header left={back} title={title} />
        <Body label={title}>
          <div
            className="g-glass g-rise"
            style={s(
              'border-radius:28px;padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center',
            )}
          >
            <Gi n="bowl" size="lg" style={{ color: 'var(--ink2)' }} />
            <p className="g-t-3" role="status" style={s('margin:0')}>
              {tr('liff.cart.empty')}
            </p>
            <button type="button" className="g-btn g-btn-p" onClick={() => go('/menu')}>
              {tr('liff.checkout.emptyBack')}
            </button>
          </div>
        </Body>
      </>
    );
  }

  return (
    <>
      <Header left={back} title={title} />
      <Body label={title} bottom={132} fade={130}>
        <div style={s('display:flex;flex-direction:column;gap:18px')}>
          <section className="g-rise" aria-labelledby="co-items" style={s('--d:.04s')}>
            <SectionLabel id="co-items">{tr('liff.checkout.items')}</SectionLabel>
            <ul
              className="g-glass"
              style={s('border-radius:28px;padding:4px 16px;margin:0;list-style:none')}
            >
              {cart.map((line) => {
                const item = findItem(menu, line.menuItemId);
                if (!item) return null;
                const picked = item.modifierGroups
                  .flatMap((g) => g.options)
                  .filter((o) => line.optionIds.includes(o.id))
                  .map(name);
                const detail = [...picked, ...(line.note ? [`“${line.note}”`] : [])];
                return (
                  <li key={line.key} className="g-row" style={s('padding:10px 0;min-height:0')}>
                    <DishThumb item={item} box={48} art={38} radius={16} />
                    <div style={s('flex-grow:1;min-width:0')}>
                      <div className="g-t-3" style={s('font-size:15px')}>
                        {name(item)}
                      </div>
                      <div className="g-t-c">
                        {detail.length > 0 ? `${detail.join(', ')} · ` : ''}×{line.qty}
                      </div>
                    </div>
                    <span className="g-num g-t-3" style={s('font-size:15px')}>
                      {formatBaht(unitEstimate(item, line.optionIds) * line.qty, locale)}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="g-t-c" style={s('padding:6px 10px 0')}>
              {tr('liff.checkout.estimateNote')}
            </div>
          </section>

          {editing ? (
            <>
              <Notice icon="info">{tr('liff.edit.note')}</Notice>
              <button
                type="button"
                className="g-btn g-btn-block"
                disabled={busy}
                onClick={() => {
                  const id = editing.orderId;
                  endEdit();
                  go(`/orders/${id}`, { replace: true });
                }}
              >
                {tr('liff.edit.discard')}
              </button>
            </>
          ) : null}

          {unavailable.length > 0 ? (
            <UnavailableNotice lines={unavailable} onRemove={removeUnavailable} />
          ) : null}

          {editing ? null : (
            <>
              <section className="g-rise" aria-labelledby="co-deliver" style={s('--d:.08s')}>
                <SectionLabel id="co-deliver">{tr('liff.menu.deliverTitle')}</SectionLabel>
                <div
                  className="g-glass"
                  style={s(
                    'border-radius:28px;padding:14px 16px;display:flex;flex-direction:column;gap:10px',
                  )}
                >
                  {last ? (
                    <button
                      type="button"
                      className="g-btn g-btn-sm"
                      style={s('align-self:flex-start;max-width:100%;overflow:hidden')}
                      onClick={() => setForm({ ...form, ...prefilled(info), method: form.method })}
                    >
                      <span style={s('overflow:hidden;text-overflow:ellipsis')}>
                        {tr('liff.checkout.prefill', {
                          building: last.building,
                          name: last.recipientName,
                        })}
                      </span>
                    </button>
                  ) : null}
                  <label className="g-field" style={s('height:48px')}>
                    <Gi n="user" size="sm" />
                    <input
                      ref={nameField}
                      type="text"
                      value={form.name}
                      maxLength={NAME_MAX}
                      autoComplete="off"
                      aria-label={tr('liff.checkout.name')}
                      placeholder={tr('liff.checkout.name')}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label className="g-field" style={s('height:48px')}>
                    <Gi n="building" size="sm" />
                    <select
                      ref={buildingField}
                      value={form.building}
                      aria-label={tr('liff.checkout.building')}
                      data-empty={form.building === ''}
                      onChange={(e) => setForm({ ...form, building: e.target.value })}
                    >
                      <option value="">{tr('liff.checkout.buildingPick')}</option>
                      {info.buildings.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    <Gi n="chevronDown" size="sm" />
                  </label>
                  <label className="g-field" style={s('height:48px')}>
                    <Gi n="note" size="sm" />
                    <input
                      type="text"
                      value={form.note}
                      maxLength={NOTE_MAX}
                      autoComplete="off"
                      aria-label={tr('liff.checkout.note')}
                      placeholder={tr('liff.checkout.notePlaceholder')}
                      onChange={(e) => setForm({ ...form, note: e.target.value })}
                    />
                  </label>
                  {tried && (problems.includes('building') || problems.includes('name')) ? (
                    <Notice tone="bad" icon="warn" alert>
                      {tr('liff.checkout.required')}
                    </Notice>
                  ) : null}
                  <div
                    className="g-t-c"
                    style={s('display:flex;gap:7px;align-items:flex-start;line-height:1.5')}
                  >
                    <Gi n="info" style={{ width: 14, height: 14, marginTop: 3 }} />
                    {tr('liff.checkout.deliverNote')}
                  </div>
                  <button
                    type="button"
                    className="g-btn g-btn-sm"
                    style={s('align-self:flex-start')}
                    onClick={() => go('/member')}
                  >
                    {tr('liff.member.link')}
                  </button>
                </div>
              </section>

              <section className="g-rise" aria-labelledby="co-pay" style={s('--d:.12s')}>
                <SectionLabel id="co-pay">{tr('liff.checkout.payment')}</SectionLabel>
                <div
                  role="radiogroup"
                  aria-labelledby="co-pay"
                  style={s('display:flex;flex-direction:column;gap:10px')}
                >
                  {methods.map((method) => (
                    <PayRadio
                      key={method}
                      method={method}
                      checked={form.method === method}
                      onChange={() => setForm({ ...form, method })}
                    />
                  ))}
                </div>
              </section>

              {problems.includes('closed') ? (
                <Notice tone="warn" icon="clock">
                  {tr('liff.error.SHOP_CLOSED')}
                </Notice>
              ) : null}
            </>
          )}
          {error ? (
            <Notice tone="bad" icon="warn" alert>
              {error}
            </Notice>
          ) : null}
        </div>
      </Body>

      <Dock style={s('border-radius:34px;padding:10px 10px 10px 20px')}>
        <div style={s('flex-grow:1;min-width:0;line-height:1.3')}>
          <div className="g-t-c">{tr('liff.order.total')}</div>
          <div className="g-num g-t-1" style={s('font-size:26px')}>
            {total}
          </div>
        </div>
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg"
          style={s('height:56px')}
          disabled={busy || (!editing && problems.includes('closed')) || unavailable.length > 0}
          aria-busy={busy}
          onClick={() =>
            editing
              ? void saveLines(
                  { id: editing.orderId, version: editing.version },
                  toOrderItems(cart),
                  true,
                )
              : void submit()
          }
        >
          {editing
            ? busy
              ? tr('liff.edit.saving')
              : tr('liff.edit.save')
            : busy
              ? tr('liff.checkout.placing')
              : tr('liff.checkout.order')}
          <Gi n="chevronRight" size="sm" />
        </button>
      </Dock>
      {asking ? (
        <OpenOrderSheet
          step={asking.step}
          warning={asking.warning}
          busy={busy}
          onContinue={() => {
            if (asking.warning.canMerge) setAsking({ ...asking, step: 'choose' });
            else {
              setAsking(null);
              void place();
            }
          }}
          onView={() => go(`/orders/${asking.warning.order.id}`)}
          onMerge={() =>
            void saveLines(asking.warning.order, mergedItems(asking.warning.order, cart))
          }
          onSeparate={() => {
            setAsking(null);
            void place();
          }}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The cart lines that cannot be ordered (LINE-02): each by name (or "a dish no longer available"
 * when the name is not known any more) with its own remove button.
 */
export function UnavailableNotice({
  lines,
  onRemove,
}: {
  lines: readonly UnavailableLine[];
  onRemove: (key: string) => void;
}) {
  const tr = useT();
  const { locale } = useApp();
  const nameOf = (line: UnavailableLine) =>
    line.name
      ? locale === 'en' && line.name.nameEn
        ? line.name.nameEn
        : line.name.nameTh
      : tr('liff.cart.unavailableItem');
  return (
    <Notice tone="bad" icon="warn" alert>
      <p style={s('margin:0 0 8px')}>{tr('liff.cart.unavailableTitle')}</p>
      <ul
        style={s('margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px')}
      >
        {lines.map((line) => (
          <li key={line.key} style={s('display:flex;align-items:center;gap:10px')}>
            <span style={s('flex-grow:1;min-width:0;overflow-wrap:anywhere')}>
              {`${nameOf(line)} ×${line.qty}`}
            </span>
            <button
              type="button"
              className="g-btn g-btn-sm"
              aria-label={tr('liff.cart.removeNamed', { name: nameOf(line) })}
              onClick={() => onRemove(line.key)}
            >
              {tr('liff.cart.remove')}
            </button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** Shown on first use, before anything else: the notice and a button that stores the acknowledgement. */
export function PrivacyGate({ refreshInfo }: { refreshInfo: () => Promise<void> }) {
  const tr = useT();
  const { api } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Header title={tr('liff.privacy.title')} />
      <Body label={tr('liff.privacy.title')}>
        <div
          className="g-glass g-rise"
          style={s(
            'border-radius:28px;padding:18px 16px;display:flex;flex-direction:column;gap:14px',
          )}
        >
          <div style={s('display:flex;gap:12px;align-items:flex-start')}>
            <div
              className="g-ico"
              aria-hidden="true"
              style={s('background:#2457b8;width:40px;height:40px;border-radius:14px')}
            >
              <Gi n="shieldCheck" />
            </div>
            <p className="g-t-b" style={s('margin:0;min-width:0;flex:1')}>
              {tr('liff.privacy.body')}
            </p>
          </div>
          {error ? (
            <Notice tone="bad" icon="warn" alert>
              {error}
            </Notice>
          ) : null}
          <button
            type="button"
            className="g-btn g-btn-p g-btn-lg g-btn-block"
            disabled={busy}
            aria-busy={busy}
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
        </div>
      </Body>
    </>
  );
}
