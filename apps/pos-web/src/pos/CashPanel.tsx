import { formatBaht } from '@sds/i18n';
import { type OrderDto, satang } from '@sds/shared';
import { useState } from 'react';
import { errorText } from '../api/errors.ts';
import { useActivityHold, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { cashView, keyToTender, type PayMethod, quickTenders } from './payment-model.ts';
import { flowFor } from './payment-store.ts';

const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'] as const;

/**
 * Cash: the SERVER's total in big type, a keypad and quick-tender chips for what the customer
 * handed over, the change from the shared calculation, and one confirm. Confirming creates the
 * payment as `{method: 'cash', tendered}` (the API takes no amount); when changing from a waiting
 * payment, it is the change-method call. The tender is locked while a request is in flight or its
 * outcome is unsure, because a retry must send the same body. That tender is kept in the payment
 * store next to the request id, so a panel that is closed and opened again while the outcome is
 * unsure starts with the tender it sent, and a retry is the same call again.
 */
export function CashPanel({
  order,
  changeFrom,
  onAttempt,
  onDone,
}: {
  order: OrderDto;
  /** The waiting payment this one replaces (the change-method call), if any. */
  changeFrom?: string;
  onAttempt?: (method: PayMethod) => void;
  onDone?: () => void;
}) {
  const { payments } = useServices();
  const flow = useStoreState(payments);
  const tr = useT();
  const locale = useLocale();
  const mine = flowFor(flow, order.id);
  const action = changeFrom ? 'changeMethod' : 'create';
  const attempt = mine.unsure?.action === action ? mine.unsure : null;
  // The body that may already be saved. Only a cash body can be restored into this keypad; one
  // of another method is called out below and leaves the keypad free.
  const sentCash = attempt?.input?.method === 'cash' ? attempt.input : null;
  const [tender, setTender] = useState<ReturnType<typeof keyToTender>>(
    sentCash ? satang(sentCash.tendered) : null,
  );
  useActivityHold(tender !== null);

  const sending = mine.sending !== null;
  const unsure = attempt !== null;
  const locked = sending || (sentCash !== null && tender !== null);
  const view = cashView(order.totalSatang, tender);
  const chips = quickTenders(order.totalSatang);
  const failure = !sending && mine.refused?.action === action ? mine.refused.error : null;

  async function confirm() {
    // An unsure request is retried through this very button (same tender, same request id).
    if (sending || tender === null || !view.canConfirm) return;
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
    : view.change !== null && view.change > 0
      ? tr('payment.cash.confirmWithChange', {
          amount: money(order.totalSatang),
          change: money(view.change),
        })
      : tr('payment.confirmAmount', { amount: money(order.totalSatang) });

  return (
    <section className="cash" aria-labelledby="cash-title">
      <h3 id="cash-title" className="cash__title">
        {tr('payment.cash.title')}
      </h3>
      <div className="cash__grid">
        <div className="cash__main">
          <div className="field-group">
            <span className="label" id="tender-label">
              {tr('payment.cash.tendered')}
            </span>
            <output className="cash__tender money" aria-labelledby="tender-label">
              {tender === null ? (
                <span className="muted cash__placeholder">{tr('payment.cash.enterAmount')}</span>
              ) : (
                money(tender)
              )}
            </output>
          </div>
          <fieldset className="chips">
            <legend className="visually-hidden">{tr('payment.cash.tendered')}</legend>
            <button
              type="button"
              className={`btn${tender === chips.exact ? ' btn--on' : ''}`}
              disabled={locked}
              onClick={() => setTender(chips.exact)}
            >
              {tr('payment.cash.exact')}
            </button>
            {chips.others.map((value) => (
              <button
                key={value}
                type="button"
                className={`btn${tender === value ? ' btn--on' : ''}`}
                disabled={locked}
                onClick={() => setTender(value)}
              >
                {formatBaht(value, locale, { decimals: 'auto' })}
              </button>
            ))}
          </fieldset>
          <div
            className={`change${view.shortBy !== null ? ' change--short' : ''}`}
            aria-live="polite"
          >
            {view.shortBy !== null ? (
              <span className="change__label">
                {tr('payment.cash.short', { amount: money(view.shortBy) })}
              </span>
            ) : (
              <>
                <span className="change__label strong">{tr('payment.cash.change')}</span>
                <span className="change__value money">
                  {view.change === null ? '' : money(view.change)}
                </span>
              </>
            )}
          </div>
          {unsure ? (
            <p className="error" role="alert">
              {tr(sentCash ? 'payment.unsure' : 'payment.unsureOtherMethod')}
            </p>
          ) : failure ? (
            <p className="error" role="alert">
              {errorText(tr, failure, 'payment')}
            </p>
          ) : null}

          <button
            type="button"
            className="btn btn-success btn-lg btn-block"
            disabled={sending || !view.canConfirm}
            aria-busy={sending}
            onClick={() => void confirm()}
          >
            <Icon name="check-circle" />
            {confirmLabel}
          </button>
        </div>
        <fieldset className="keypad">
          <legend className="visually-hidden">{tr('payment.cash.keypad')}</legend>
          {DIGIT_KEYS.map((digit) => (
            <button
              key={digit}
              type="button"
              className="btn keypad__key"
              disabled={locked}
              onClick={() => setTender((current) => keyToTender(current, digit))}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            className="btn keypad__key"
            disabled={locked}
            aria-label={tr('payment.cash.backspace')}
            onClick={() => setTender((current) => keyToTender(current, 'back'))}
          >
            <Icon name="backspace" />
          </button>
          <button
            type="button"
            className="btn btn-soft keypad__clear"
            disabled={locked}
            onClick={() => setTender(null)}
          >
            {tr('payment.cash.clear')}
          </button>
        </fieldset>
      </div>
    </section>
  );
}
