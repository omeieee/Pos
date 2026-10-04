import { formatBaht } from '@sds/i18n';
import { type OrderDto, type Satang, satang } from '@sds/shared';
import { useState } from 'react';
import { errorText } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useActivityHold, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import type { EnqueueResult } from './outbox-store.ts';
import { saveErrorText } from './outbox-text.ts';
import { Callout, usePayDims } from './PayParts.tsx';
import { cashView, keyToTender, type PayMethod, quickTenders } from './payment-model.ts';
import { flowFor } from './payment-store.ts';
import './pay-glass.css';

const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'] as const;

/**
 * Cash: the SERVER's total in big type, a keypad and quick-tender chips for what the customer
 * handed over, the change from the shared calculation, and one confirm. Confirming creates the
 * payment as `{method: 'cash', tendered}` (the API takes no amount); when changing from a waiting
 * payment, it is the change-method call. The tender is locked while a request is in flight or its
 * outcome is unsure, because a retry must send the same body. That tender is kept in the payment
 * store next to the request id, so a panel that is closed and opened again while the outcome is
 * unsure starts with the tender it sent, and a retry is the same call again.
 *
 * Offline (`queue` given): the same keypad and the same change calculation, but confirming saves
 * the cash to the outbox instead of calling the server. The caller says what the total is: an
 * estimate for an order the server has not got yet. Nothing is shown as paid: the order page shows
 * the entry as waiting to sync until the server confirms it.
 */
export function CashPanel({
  order,
  changeFrom,
  onAttempt,
  onDone,
  queue,
  stacked = false,
}: {
  order: Pick<OrderDto, 'id' | 'totalSatang'>;
  /** The waiting payment this one replaces (the change-method call), if any. */
  changeFrom?: string;
  onAttempt?: (method: PayMethod) => void;
  onDone?: () => void;
  /** Saves the tender to the outbox (offline); without it the payment goes straight to the server. */
  /** Keypad under the amounts instead of beside them (a dialog is too narrow for two columns). */
  stacked?: boolean;
  queue?: {
    submit: (
      tender: Satang,
    ) => Promise<EnqueueResult> /** The total is an estimate (the server has not got the order yet). */;
    estimated?: boolean;
  };
}) {
  const { payments } = useServices();
  const flow = useStoreState(payments);
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  const stack = phone || stacked;
  const mine = flowFor(flow, order.id);
  const action = changeFrom ? 'changeMethod' : 'create';
  const attempt = mine.unsure?.action === action ? mine.unsure : null;
  // The body that may already be saved. Only a cash body can be restored into this keypad; one
  // of another method is called out below and leaves the keypad free.
  const sentCash = attempt?.input?.method === 'cash' ? attempt.input : null;
  const [tender, setTender] = useState<ReturnType<typeof keyToTender>>(
    sentCash ? satang(sentCash.tendered) : null,
  );
  const [saving, setSaving] = useState(false);
  const [notSaved, setNotSaved] = useState<Extract<EnqueueResult, { ok: false }>['reason'] | null>(
    null,
  );
  useActivityHold(tender !== null);

  const sending = mine.sending !== null || saving;
  const unsure = attempt !== null;
  const locked = sending || (sentCash !== null && tender !== null);
  const view = cashView(order.totalSatang, tender);
  const chips = quickTenders(order.totalSatang);
  const failure = !sending && mine.refused?.action === action ? mine.refused.error : null;

  async function confirm() {
    // An unsure request is retried through this very button (same tender, same request id).
    if (sending || tender === null || !view.canConfirm) return;
    if (queue) {
      setSaving(true);
      setNotSaved(null);
      const saved = await queue.submit(tender).finally(() => setSaving(false));
      if (saved.ok) onDone?.();
      else setNotSaved(saved.reason);
      return;
    }
    onAttempt?.('cash');
    const input = { method: 'cash', tendered: tender } as const;
    const outcome = changeFrom
      ? await payments.changeMethod(order.id, changeFrom, input)
      : await payments.create(order.id, input);
    if (outcome.ok) onDone?.();
  }

  const money = (value: number) => formatBaht(value, locale);
  const confirmLabel = sending
    ? tr('payment.sending')
    : queue
      ? tr('outbox.cash.confirm')
      : view.change !== null && view.change > 0
        ? tr('payment.cash.confirmWithChange', {
            amount: money(order.totalSatang),
            change: money(view.change),
          })
        : tr('payment.confirmAmount', { amount: money(order.totalSatang) });
  // Nothing handed over yet counts as the whole total still due, as in the design.
  const owed = tender === null ? order.totalSatang : view.shortBy;
  const short = owed !== null;

  return (
    <section
      aria-labelledby="cash-title"
      className="g-rise pay-grow"
      style={s(
        `display:flex;gap:${dims.gap}px;width:100%;min-width:0;${stack ? 'flex-direction:column;' : ''}`,
      )}
    >
      <h3 id="cash-title" className="visually-hidden">
        {tr('payment.cash.title')}
      </h3>
      <div style={s('flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:16px')}>
        <div className="g-sunk" style={s('padding:18px 20px')}>
          <div style={s('display:flex;align-items:center;justify-content:space-between;gap:8px')}>
            <span className="g-t-c" id="tender-label">
              {tr('payment.cash.tendered')}
            </span>
            <button
              type="button"
              className="g-btn"
              style={s('height:44px;padding:0 16px;font-size:15px')}
              disabled={locked || tender === null}
              onClick={() => setTender(null)}
            >
              {tr('payment.cash.clear')}
            </button>
          </div>
          <output
            className="g-num"
            data-testid="cash-tender"
            aria-labelledby="tender-label"
            style={s(
              `display:block;min-height:70px;font-size:${phone ? 46 : 56}px;line-height:1.25;font-weight:600;letter-spacing:-.015em`,
            )}
          >
            {tender === null ? (
              <span
                className="g-t-2"
                style={s('display:block;padding-top:20px;color:var(--ink3);font-weight:500')}
              >
                {tr('payment.cash.enterAmount')}
              </span>
            ) : (
              money(tender)
            )}
          </output>
        </div>
        <fieldset style={s('border:0;margin:0;padding:0;min-width:0')}>
          <legend className="visually-hidden">{tr('payment.cash.tendered')}</legend>
          <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
            <button
              type="button"
              className={`g-chip${tender === chips.exact ? ' g-on' : ''}`}
              aria-pressed={tender === chips.exact}
              disabled={locked}
              onClick={() => setTender(chips.exact)}
            >
              {tr('payment.cash.exact')}
            </button>
            {chips.others.map((value) => (
              <button
                key={value}
                type="button"
                className={`g-chip${tender === value ? ' g-on' : ''}`}
                aria-pressed={tender === value}
                disabled={locked}
                onClick={() => setTender(value)}
              >
                {formatBaht(value, locale, { decimals: 'auto' })}
              </button>
            ))}
          </div>
        </fieldset>
        <div
          className={short ? 'g-b-warn' : 'g-b-ok'}
          data-testid="cash-change"
          style={s('padding:20px;border-radius:26px;display:flex;flex-direction:column;gap:2px')}
        >
          <div className="g-t-c" style={s('color:inherit;opacity:.85')}>
            {tr(short ? 'payment.cash.shortLabel' : 'payment.cash.change')}
          </div>
          <div
            className="g-num"
            aria-hidden="true"
            style={s(
              `font-size:${phone ? 42 : 52}px;line-height:1.25;font-weight:600;letter-spacing:-.015em`,
            )}
          >
            {owed !== null ? money(owed) : money(view.change ?? 0)}
          </div>
          {/* The words of the amount, read out when it changes. */}
          <span className="visually-hidden" aria-live="polite">
            {owed !== null
              ? tr('payment.cash.short', { amount: money(owed) })
              : view.change === null
                ? ''
                : `${tr('payment.cash.change')} ${money(view.change)}`}
          </span>
        </div>
        {queue?.estimated ? (
          <Callout tone="warn" icon="info">
            {tr('outbox.cash.estimate')}
          </Callout>
        ) : null}
        {notSaved ? (
          <Callout tone="bad" role="alert">
            {saveErrorText(tr, notSaved)}
          </Callout>
        ) : unsure ? (
          <Callout tone="bad" role="alert">
            {tr(sentCash ? 'payment.unsure' : 'payment.unsureOtherMethod')}
          </Callout>
        ) : failure ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, failure, 'payment')}
          </Callout>
        ) : null}
        <div style={s('flex-grow:1')} />
        <button
          type="button"
          className="g-btn g-btn-ok g-btn-lg g-btn-block"
          style={s(
            'height:auto;min-height:58px;padding-top:8px;padding-bottom:8px;white-space:normal;text-align:center;line-height:1.3',
          )}
          disabled={sending || !view.canConfirm}
          aria-busy={sending}
          onClick={() => void confirm()}
        >
          <Gi n="check" />
          {confirmLabel}
        </button>
      </div>
      <fieldset
        style={s(
          `${stack ? 'width:100%;max-width:360px;align-self:center;' : `width:${dims.keypad}px;flex:none;`}border:0;margin:0;padding:0;min-width:0`,
        )}
      >
        <legend className="visually-hidden">{tr('payment.cash.keypad')}</legend>
        <div
          style={s('display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-content:start')}
        >
          {DIGIT_KEYS.map((digit) => (
            <button
              key={digit}
              type="button"
              className="pay-key"
              disabled={locked}
              onClick={() => setTender((current) => keyToTender(current, digit))}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            className="pay-key"
            disabled={locked}
            aria-label={tr('payment.cash.backspace')}
            onClick={() => setTender((current) => keyToTender(current, 'back'))}
          >
            <Gi n="backspace" size="lg" />
          </button>
        </div>
      </fieldset>
    </section>
  );
}
