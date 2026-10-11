import { formatBaht } from '@sds/i18n';
import type {
  AdjustRefundInput,
  CorrectionPaymentAction,
  OrderDto,
  PastOrderPaymentAction,
  PaymentRefundDto,
} from '@sds/shared';
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
  CORRECTION_CHOICES,
  canCorrectOrder,
  type DraftLine,
  defaultPaymentAction,
  draftFromOrder,
  hasActivePayment,
  hasClaimedPayment,
  removeLine,
  setLineQty,
} from './correction-model.ts';
import { buildMenu } from './menu-model.ts';
import { localName } from './names.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from './PayParts.tsx';

type Sheet = 'edit' | 'void' | null;
const VOID_CHOICES: readonly PastOrderPaymentAction[] = ['void', 'refund'];
const REFUND_METHODS: readonly AdjustRefundInput['method'][] = ['cash', 'promptpay'];
const LOST_ANSWER = ['NETWORK', 'TIMEOUT'];

/** What an adjusted payment left to do. The figures are the server's (the refund row, `dueSatang`). */
type Done =
  | { kind: 'refund'; rows: readonly NewRefund[] }
  | { kind: 'collect'; amountSatang: number | null };

/** A refund row the server created by this save: its own amount and method, never summed here. */
export interface NewRefund {
  id: string;
  amountSatang: number;
  method: PaymentRefundDto['method'];
}

/**
 * The refund rows that appeared after the save: those whose id was not in the ledger before it.
 * Null when that cannot be told (no ledger was read before the save), so the caller says to check
 * the payment panel instead of naming an older refund or a number that may be too low.
 */
export function newRefunds(
  before: readonly { id: string }[] | undefined,
  after: readonly NewRefund[] | undefined,
): NewRefund[] | null {
  if (!before || !after) return null;
  const seen = new Set(before.map((row) => row.id));
  return after.filter((row) => !seen.has(row.id));
}

/** Takes staff to the payment screen of the same page (it sits below the order, or beside it). */
function goToPayment() {
  const heading = document.getElementById('pay-title');
  heading?.scrollIntoView({ block: 'start' });
  heading?.focus({ preventScroll: true });
}

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
function PaymentChoice<A extends CorrectionPaymentAction>({
  value,
  onChange,
  disabled,
  hint,
  actions,
  unavailable = [],
}: {
  value: A | null;
  onChange: (value: A) => void;
  disabled: boolean;
  hint: string;
  actions: readonly A[];
  /** Shown but off (adjust while a claim is waiting). */
  unavailable?: readonly A[];
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
        {actions.map((action) => (
          <label key={action} className="g-chip" style={s('flex:1;padding:0 10px')}>
            <input
              type="radio"
              name="fix-payment"
              checked={value === action}
              disabled={disabled || unavailable.includes(action)}
              onChange={() => onChange(action)}
            />
            {tr(`payment.void.kind.${action}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** How the difference goes back. No amount is asked: the server works it out. */
function RefundChoice({
  method,
  onMethod,
  note,
  onNote,
  disabled,
}: {
  method: AdjustRefundInput['method'] | null;
  onMethod: (value: AdjustRefundInput['method']) => void;
  note: string;
  onNote: (value: string) => void;
  disabled: boolean;
}) {
  const tr = useT();
  return (
    <fieldset
      data-testid="refund-choice"
      style={s(
        'border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:8px',
      )}
    >
      <legend className="g-t-3" style={s('font-size:15px;padding:0')}>
        {tr('order.fix.refund.method')}
      </legend>
      <div className="g-t-c">{tr('order.fix.adjust.refundTitle')}</div>
      <div className="g-seg" style={s('display:flex;width:100%')}>
        {REFUND_METHODS.map((value) => (
          <label key={value} className="g-chip" style={s('flex:1;padding:0 10px')}>
            <input
              type="radio"
              name="fix-refund-method"
              checked={method === value}
              disabled={disabled}
              onChange={() => onMethod(value)}
            />
            {tr(`order.fix.refund.${value}`)}
          </label>
        ))}
      </div>
      <TextRow
        id="fix-refund-note"
        label={tr('order.fix.refund.reference')}
        value={note}
        disabled={disabled}
        onChange={onNote}
      />
    </fieldset>
  );
}

/** The result line of an adjusted payment: amounts only when the server gave them. */
function doneText(tr: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>, done: Done) {
  if (done.kind === 'refund') {
    // No new row to name: point to the refund list of the payment panel, with no number.
    if (done.rows.length === 0) return [tr('order.fix.done.refundNoAmount')];
    return done.rows.map((row) =>
      tr('order.fix.done.refund', {
        amount: formatBaht(row.amountSatang, locale),
        method: tr(`payment.method.${row.method}`),
      }),
    );
  }
  return [
    done.amountSatang === null
      ? tr('order.fix.done.collectNoAmount')
      : tr('order.fix.done.collect', { amount: formatBaht(done.amountSatang, locale) }),
  ];
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
  const [action, setAction] = useState<CorrectionPaymentAction | null>(() =>
    defaultPaymentAction(order),
  );
  // Asked only after the server says the new total is lower (it works the amount out itself).
  const [refundNeeded, setRefundNeeded] = useState(false);
  const [refundMethod, setRefundMethod] = useState<AdjustRefundInput['method'] | null>(null);
  const [refundNote, setRefundNote] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);
  useActivityHold(true);

  const paid = hasActivePayment(order);
  const claimed = hasClaimedPayment(order);
  const input = buildCorrection(order, {
    lines,
    note,
    reason,
    paymentAction: action,
    refund: refundNeeded ? { method: refundMethod, referenceNote: refundNote } : undefined,
  });
  const addable = addableItems(buildMenu(entities).flatMap((category) => category.items));
  const ready =
    input !== null &&
    (!paid || understood) &&
    (!refundNeeded || action !== 'adjust' || refundMethod !== null) &&
    !sending;

  async function submit() {
    if (!input || !ready || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    // The refund rows already on the ledger (undefined when it was never read for this order).
    const refundsBefore = payments.getState().ledger[order.id]?.refunds;
    try {
      const result = await auth.runSensitive(() => api.orders.correct(order.id, input));
      if (result.ok) {
        const saved = result.value;
        store.apply({ type: 'order.upserted', id: saved.id, rev: saved.rev, data: saved });
        // The server retired or adjusted the payment if the total changed: read the payments again
        // (refunds are not on the realtime feed), then show what the server says is owed or returned.
        await payments.refresh(order.id);
        const ledger = payments.getState().ledger[order.id];
        const adjusted = action === 'adjust' && paid;
        if (adjusted && input.refund) {
          // Only rows that were not there before this save: a stale ledger shows none of them.
          setDone({ kind: 'refund', rows: newRefunds(refundsBefore, ledger?.refunds) ?? [] });
        } else if (adjusted && saved.paymentStatus === 'partially_paid') {
          setDone({ kind: 'collect', amountSatang: ledger?.dueSatang ?? null });
        } else {
          onClose();
        }
      } else if (result.error) {
        setError(result.error);
        // The server decides whether the total went down: ask for the refund method only then.
        const code = isApiClientError(result.error) ? result.error.code : '';
        if (code === 'REFUND_DETAILS_REQUIRED') setRefundNeeded(true);
        if (code === 'REFUND_NOT_NEEDED') setRefundNeeded(false);
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  if (done) {
    return (
      <PayModal labelledBy="fix-title" onClose={onClose}>
        <SheetBody>
          <SheetTitle id="fix-title">{tr('order.fix.done.title')}</SheetTitle>
          <Callout tone="info" icon="info" role="status">
            {doneText(tr, locale, done).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </Callout>
          {done.kind === 'collect' ? (
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              onClick={() => {
                onClose();
                goToPayment();
              }}
            >
              {tr('order.fix.done.goPay')}
            </button>
          ) : null}
          <button type="button" className="g-btn g-btn-block" onClick={onClose}>
            {tr('order.fix.done.close')}
          </button>
        </SheetBody>
      </PayModal>
    );
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
              actions={CORRECTION_CHOICES}
              unavailable={claimed ? ['adjust'] : []}
            />
            {claimed ? (
              <div className="g-t-c" role="note">
                {tr('order.fix.adjust.claimedFirst')}
              </div>
            ) : null}
            <Callout tone="warn" icon="info">
              {tr(action === 'adjust' ? 'order.fix.adjust.explain' : 'order.fix.afterEdit')}
            </Callout>
            {action === 'adjust' ? (
              refundNeeded ? (
                <RefundChoice
                  method={refundMethod}
                  onMethod={setRefundMethod}
                  note={refundNote}
                  onNote={setRefundNote}
                  disabled={sending}
                />
              ) : (
                <div className="g-t-c">{tr('order.fix.adjust.refundHint')}</div>
              )
            ) : null}
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
  const [action, setAction] = useState<PastOrderPaymentAction | null>(() => {
    const first = defaultPaymentAction(order);
    return first === 'void' || first === 'refund' ? first : null;
  });
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
            actions={VOID_CHOICES}
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
