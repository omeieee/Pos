import type { OrderDto, PastOrderPaymentAction } from '@sds/shared';
import { useRef, useState } from 'react';
import { newClientRequestId } from '../api/client.ts';
import { errorText, isApiClientError } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import {
  useActivityHold,
  useAuthStore,
  useEntities,
  useLocale,
  useServices,
  useStaffRole,
  useT,
} from '../ui/hooks.ts';
import {
  addableItems,
  addMenuLine,
  buildCorrection,
  canCorrectOrder,
  type DraftLine,
  draftFromOrder,
  hasActivePayment,
  removeLine,
  setLineQty,
} from './correction-model.ts';
import { buildMenu } from './menu-model.ts';
import { localName } from './names.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from './PayParts.tsx';

type Sheet = 'edit' | 'void' | null;
const ACTIONS: readonly PastOrderPaymentAction[] = ['void', 'refund'];
const LOST_ANSWER = ['NETWORK', 'TIMEOUT'];

/**
 * The owner's "edit order / void order" for any past order, paid or finished included. Which
 * buttons show comes from the shared permission (`order.edit_past`), so everyone else sees nothing.
 * Both sheets need a reason and a fresh step-up, say what happens to the money before the owner
 * confirms, and change the order on screen only with what the server answers (totals included).
 */
export function OrderCorrectionActions({ order }: { order: OrderDto }) {
  const tr = useT();
  const role = useStaffRole();
  const [sheet, setSheet] = useState<Sheet>(null);
  if (!canCorrectOrder(role, order)) return null;
  return (
    <>
      <div style={s('display:flex;gap:10px;flex-wrap:wrap')}>
        <button
          type="button"
          className="g-btn"
          style={s('flex:1 1 auto')}
          onClick={() => setSheet('edit')}
        >
          {tr('order.fix.edit')}
        </button>
        <button
          type="button"
          className="g-btn"
          style={s('flex:1 1 auto;color:var(--chili-ink)')}
          onClick={() => setSheet('void')}
        >
          {tr('order.fix.void')}
        </button>
      </div>
      {sheet === 'edit' ? <EditSheet order={order} onClose={() => setSheet(null)} /> : null}
      {sheet === 'void' ? <VoidSheet order={order} onClose={() => setSheet(null)} /> : null}
    </>
  );
}

/** What to do with the payment: the same two choices the payment screens use. */
function PaymentChoice({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: PastOrderPaymentAction | null;
  onChange: (value: PastOrderPaymentAction) => void;
  disabled: boolean;
  hint: string;
}) {
  const tr = useT();
  return (
    <fieldset
      style={s(
        'border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:6px',
      )}
    >
      <legend className="g-t-3" style={s('font-size:15px;padding:0')}>
        {tr('order.fix.payment.label')}
      </legend>
      <div className="g-t-c">{hint}</div>
      <div className="g-seg" style={s('display:flex;width:100%')}>
        {ACTIONS.map((action) => (
          <label key={action} className="g-chip" style={s('flex:1;padding:0 10px')}>
            <input
              type="radio"
              name="fix-payment"
              checked={value === action}
              disabled={disabled}
              onChange={() => onChange(action)}
            />
            {tr(`payment.void.kind.${action}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Understand({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const tr = useT();
  return (
    <label
      className="g-t-3"
      style={s('display:flex;gap:10px;align-items:center;min-height:44px;font-size:15px')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        style={s('width:22px;height:22px;flex:none')}
      />
      {tr('order.fix.understand')}
    </label>
  );
}

/** Quantity, remove, add a dish, the order note and a reason. The server prices and totals it all. */
function EditSheet({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { api, entities: store, payments } = useServices();
  const auth = useAuthStore();
  const entities = useEntities();
  const tr = useT();
  const locale = useLocale();
  const [lines, setLines] = useState<DraftLine[]>(() => draftFromOrder(order));
  const [note, setNote] = useState(order.note ?? '');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<PastOrderPaymentAction | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);
  useActivityHold(true);

  const paid = hasActivePayment(order);
  const input = buildCorrection(order, { lines, note, reason, paymentAction: action });
  const addable = addableItems(buildMenu(entities).flatMap((category) => category.items));
  const ready = input !== null && (!paid || understood) && !sending;

  async function submit() {
    if (!input || !ready || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await auth.runSensitive(() => api.orders.correct(order.id, input));
      if (result.ok) {
        const saved = result.value;
        store.apply({ type: 'order.upserted', id: saved.id, rev: saved.rev, data: saved });
        // The server retired the payment if the total changed: read the payments again.
        void payments.refresh(order.id);
        onClose();
      } else if (result.error) {
        setError(result.error);
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <PayModal labelledBy="fix-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="fix-title">
          {tr('order.fix.editTitle', { orderNo: order.orderNo })}
        </SheetTitle>
        <Callout tone="warn" icon="shieldCheck">
          {tr('order.fix.audited')}
        </Callout>
        <div className="g-t-3" style={s('font-size:15px')}>
          {tr('order.fix.lines')}
        </div>
        <ul
          style={s(
            'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px',
          )}
        >
          {lines.map((line) => {
            const name = localName(locale, line.nameTh, line.nameEn);
            return (
              <li key={line.key} style={s('display:flex;gap:8px;align-items:center')}>
                <span style={s('flex:1;min-width:0')}>
                  {name}
                  <span className="g-t-c" style={s('display:block')}>
                    {tr(line.orderItemId ? 'order.fix.priceKept' : 'order.fix.priceNew')}
                  </span>
                </span>
                <button
                  type="button"
                  className="g-btn"
                  style={s('min-width:44px;min-height:44px')}
                  aria-label={tr('order.fix.qtyDown', { name })}
                  disabled={sending || line.qty <= 1}
                  onClick={() => setLines(setLineQty(lines, line.key, line.qty - 1))}
                >
                  −
                </button>
                <span
                  className="g-num"
                  style={s('min-width:28px;text-align:center')}
                  aria-live="polite"
                >
                  {line.qty}
                </span>
                <button
                  type="button"
                  className="g-btn"
                  style={s('min-width:44px;min-height:44px')}
                  aria-label={tr('order.fix.qtyUp', { name })}
                  disabled={sending}
                  onClick={() => setLines(setLineQty(lines, line.key, line.qty + 1))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="g-btn"
                  style={s('min-width:44px;min-height:44px')}
                  aria-label={tr('order.fix.remove', { name })}
                  disabled={sending || lines.length <= 1}
                  onClick={() => setLines(removeLine(lines, line.key))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        {lines.length <= 1 ? <div className="g-t-c">{tr('order.fix.lastLine')}</div> : null}
        <button
          type="button"
          className="g-btn"
          disabled={sending}
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          <Gi n="plus" />
          {tr('order.fix.add')}
        </button>
        {adding ? (
          addable.length === 0 ? (
            <div className="g-t-c">{tr('order.fix.addNone')}</div>
          ) : (
            <ul style={s('list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px')}>
              {addable.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="g-chip"
                    style={s('min-height:44px;padding:0 14px')}
                    disabled={sending}
                    onClick={() => setLines(addMenuLine(lines, item))}
                  >
                    {localName(locale, item.nameTh, item.nameEn)}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
        <TextRow
          id="fix-note"
          label={tr('order.fix.note')}
          value={note}
          disabled={sending}
          onChange={setNote}
        />
        <TextRow
          id="fix-reason"
          label={tr('order.fix.reason')}
          placeholder={tr('order.fix.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={setReason}
        />
        {paid ? (
          <>
            <PaymentChoice
              value={action}
              onChange={setAction}
              disabled={sending}
              hint={tr('order.fix.payment.hintEdit')}
            />
            <Callout tone="warn" icon="info">
              {tr('order.fix.afterEdit')}
            </Callout>
            <Understand checked={understood} onChange={setUnderstood} disabled={sending} />
          </>
        ) : null}
        {error ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, error, 'correction')}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={!ready}
          aria-busy={sending}
          onClick={() => void submit()}
        >
          {sending ? tr('order.fix.sending') : tr('order.fix.save')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('order.fix.keep')}
        </button>
      </SheetBody>
    </PayModal>
  );
}

/** Void the whole order. The request id stays the same for a retry of a lost answer. */
function VoidSheet({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { api, entities: store, payments } = useServices();
  const auth = useAuthStore();
  const tr = useT();
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<PastOrderPaymentAction | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(newClientRequestId());
  const inFlight = useRef(false);
  useActivityHold(true);

  const paid = hasActivePayment(order);
  const text = reason.trim();
  const ready = text !== '' && (!paid || (action !== null && understood)) && !sending;

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await auth.runSensitive(() =>
        api.orders.void(order.id, {
          clientRequestId: requestId.current,
          reason: text,
          expectedVersion: order.version,
          ...(paid && action ? { paymentAction: action } : {}),
        }),
      );
      if (result.ok) {
        const saved = result.value;
        store.apply({ type: 'order.upserted', id: saved.id, rev: saved.rev, data: saved });
        void payments.refresh(order.id);
        onClose();
      } else if (result.error) {
        setError(result.error);
        // A real refusal is not a lost answer, so the next try is a new request; a lost one is retried as is.
        const lost = isApiClientError(result.error) && LOST_ANSWER.includes(result.error.code);
        if (!lost) requestId.current = newClientRequestId();
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <PayModal labelledBy="fix-void-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="fix-void-title">
          {tr('order.fix.voidTitle', { orderNo: order.orderNo })}
        </SheetTitle>
        <Callout tone="warn" icon="shieldCheck">
          {tr('order.fix.audited')}
        </Callout>
        <TextRow
          id="fix-void-reason"
          label={tr('order.fix.voidReason')}
          placeholder={tr('order.cancel.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={setReason}
        />
        {paid ? (
          <PaymentChoice
            value={action}
            onChange={setAction}
            disabled={sending}
            hint={tr('order.fix.payment.hintVoid')}
          />
        ) : null}
        <Callout tone="warn" icon="info">
          {tr('order.fix.afterVoid')}
        </Callout>
        {paid ? (
          <Understand checked={understood} onChange={setUnderstood} disabled={sending} />
        ) : null}
        {error ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, error, 'correction')}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={!ready}
          aria-busy={sending}
          onClick={() => void submit()}
        >
          {sending ? tr('order.fix.sending') : tr('order.fix.voidConfirm')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('order.fix.keep')}
        </button>
      </SheetBody>
    </PayModal>
  );
}
