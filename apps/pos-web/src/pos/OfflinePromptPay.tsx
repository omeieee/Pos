import { formatBaht, formatDate } from '@sds/i18n';
import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import {
  useActivityHold,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { LocalQr } from './LocalQr.tsx';
import { amountKindKey, refusalKey } from './offline-promptpay-model.ts';
import type { EnqueueResult } from './outbox-store.ts';
import { saveErrorText } from './outbox-text.ts';
import { Callout, usePayDims } from './PayParts.tsx';
import { QrCard } from './PromptPayPanel.tsx';

/**
 * PromptPay while the device cannot reach the server (D-20): the QR is drawn here from the PromptPay
 * ID this device saved, and the payment is saved to the outbox when the STAFF MEMBER says the
 * customer has paid and the money is in the bank app. Nothing here confirms anything by itself.
 *
 * What staff are told, before the customer scans: which account the QR pays (the last four digits)
 * and when it was saved, to compare with the bank app; and that the amount is the saved menu's
 * ESTIMATE (a local order) or the server's last known total (an order the server has).
 *
 * No QR is shown when there is no saved ID, when the server said it changed, when it is more than 24
 * hours old, or when the amount is not a valid positive amount: the reason says to reconnect.
 */
export function OfflinePromptPay({
  amountSatang,
  amountKind,
  submit,
}: {
  amountSatang: number | null;
  amountKind: 'estimate' | 'server';
  /** Saves the payment behind its order; the caller knows the order and its label. */
  submit: (qr: { qrAmountSatang: number; qrTargetMasked: string }) => Promise<EnqueueResult>;
}) {
  const { promptpay } = useServices();
  // Re-draws when the saved ID changes, and every half minute so an old copy stops being used.
  useStoreState(promptpay);
  useNow(30_000);
  useActivityHold(true);
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  const [saving, setSaving] = useState(false);
  const [notSaved, setNotSaved] = useState<Extract<EnqueueResult, { ok: false }>['reason'] | null>(
    null,
  );
  const qr = promptpay.qr(amountSatang);

  if (!qr.ok || amountSatang === null) {
    const reason = qr.ok ? 'badAmount' : qr.reason;
    return (
      <section
        aria-labelledby="oqr-title"
        style={s('width:100%;display:flex;flex-direction:column;gap:12px')}
      >
        <h3 id="oqr-title" className="visually-hidden">
          {tr('payment.offlineQr.title')}
        </h3>
        <Callout tone="warn" role="alert">
          {tr(refusalKey(reason))}
        </Callout>
      </section>
    );
  }

  const amount = formatBaht(amountSatang, locale);

  async function paid() {
    if (saving || amountSatang === null) return;
    // The ID may have been marked changed or have aged out since the QR was drawn.
    const again = promptpay.qr(amountSatang);
    if (!again.ok) return;
    setSaving(true);
    setNotSaved(null);
    const saved = await submit({
      qrAmountSatang: amountSatang,
      qrTargetMasked: again.masked,
    }).finally(() => setSaving(false));
    if (!saved.ok) setNotSaved(saved.reason);
  }

  return (
    <section
      aria-labelledby="oqr-title"
      className="g-rise pay-grow"
      style={s(
        `display:flex;gap:${dims.gap}px;width:100%;min-width:0;${phone ? 'flex-direction:column;' : ''}`,
      )}
    >
      <h3 id="oqr-title" className="visually-hidden">
        {tr('payment.offlineQr.title')}
      </h3>
      <div style={s(phone ? 'display:grid;place-items:center' : 'display:flex')}>
        <QrCard width={phone ? 340 : dims.qr} amount={amount}>
          <LocalQr
            payload={qr.payload}
            alt={tr('payment.offlineQr.alt', { amount })}
            size={phone || dims.layout === 'side' ? 250 : 220}
          />
        </QrCard>
      </div>
      <div style={s('flex-grow:1;display:flex;flex-direction:column;gap:14px;min-width:0')}>
        <Callout tone="warn" icon="warn" role="status">
          {tr('payment.offlineQr.banner', {
            last4: qr.last4,
            time: formatDate(qr.savedAt, locale, 'time'),
          })}
        </Callout>
        <div
          className="g-sunk"
          style={s('padding:16px 18px;display:flex;flex-direction:column;gap:6px')}
        >
          <span className="g-t-c">{tr(amountKindKey(amountKind))}</span>
          <span
            className="g-num"
            style={s('font-size:44px;line-height:1.2;font-weight:600;letter-spacing:-.015em')}
          >
            {amount}
          </span>
          {amountKind === 'estimate' ? (
            <span className="g-t-c" style={s('color:var(--amber-ink)')}>
              {tr('payment.offlineQr.estimateWarning')}
            </span>
          ) : null}
        </div>
        <p className="g-t-c" style={s('margin:0')}>
          {tr('payment.offlineQr.confirmHint')}
        </p>
        <div style={s('flex-grow:1')} />
        {notSaved ? (
          <Callout tone="bad" role="alert">
            {saveErrorText(tr, notSaved)}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-ok g-btn-lg g-btn-block"
          style={s(
            'height:auto;min-height:58px;padding-top:10px;padding-bottom:10px;white-space:normal;text-align:center;line-height:1.35',
          )}
          disabled={saving}
          aria-busy={saving}
          onClick={() => void paid()}
        >
          <Gi n="check" />
          {tr('payment.offlineQr.confirm')}
        </button>
      </div>
    </section>
  );
}
