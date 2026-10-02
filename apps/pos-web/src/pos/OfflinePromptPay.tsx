import { formatBaht, formatDate } from '@sds/i18n';
import { useState } from 'react';
import {
  useActivityHold,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { LocalQr } from './LocalQr.tsx';
import { amountKindKey, refusalKey } from './offline-promptpay-model.ts';
import type { EnqueueResult } from './outbox-store.ts';
import { saveErrorText } from './outbox-text.ts';

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
  const [saving, setSaving] = useState(false);
  const [notSaved, setNotSaved] = useState<Extract<EnqueueResult, { ok: false }>['reason'] | null>(
    null,
  );
  const qr = promptpay.qr(amountSatang);

  if (!qr.ok || amountSatang === null) {
    const reason = qr.ok ? 'badAmount' : qr.reason;
    return (
      <section className="oqr" aria-labelledby="oqr-title">
        <h3 id="oqr-title" className="pp__title">
          {tr('payment.offlineQr.title')}
        </h3>
        <p className="notice oqr__refused" role="alert">
          <Icon name="wifi-off" />
          <span>{tr(refusalKey(reason))}</span>
        </p>
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
    <section className="oqr" aria-labelledby="oqr-title">
      <h3 id="oqr-title" className="pp__title">
        {tr('payment.offlineQr.title')}
      </h3>
      <p className="notice oqr__banner" role="status">
        <Icon name="alert" />
        <span>
          {tr('payment.offlineQr.banner', {
            last4: qr.last4,
            time: formatDate(qr.savedAt, locale, 'time'),
          })}
        </span>
      </p>
      <div className="oqr__amount">
        <span className="lbl">{tr(amountKindKey(amountKind))}</span>
        <span className="amount-hero money">{amount}</span>
      </div>
      {amountKind === 'estimate' ? (
        <p className="hint">{tr('payment.offlineQr.estimateWarning')}</p>
      ) : null}
      <div className="qrbox">
        <LocalQr payload={qr.payload} alt={tr('payment.offlineQr.alt', { amount })} />
      </div>
      <p className="hint">{tr('payment.offlineQr.confirmHint')}</p>
      {notSaved ? (
        <p className="error" role="alert">
          {saveErrorText(tr, notSaved)}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-success btn-lg btn-block"
        disabled={saving}
        aria-busy={saving}
        onClick={() => void paid()}
      >
        <Icon name="check-circle" />
        {tr('payment.offlineQr.confirm')}
      </button>
    </section>
  );
}
