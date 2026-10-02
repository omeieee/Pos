import { lazy, Suspense, useState } from 'react';
import { useT } from '../ui/hooks.ts';

const QrSvg = lazy(() => import('./QrSvg.tsx'));

/**
 * The offline PromptPay QR: drawn on this device from the payload, no request, no picture address.
 * The drawing code loads when this first shows (a separate chunk, kept in the offline precache).
 * `alt` is the amount in words and nothing else: the payload holds the shop's account number.
 */
export function LocalQr({ payload, alt }: { payload: string; alt: string }) {
  const tr = useT();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="qr qr--failed" role="alert">
        <p>{tr('payment.offlineQr.failed')}</p>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="qr qr--loading" role="status">
          <span className="muted">{tr('payment.offlineQr.loading')}</span>
        </div>
      }
    >
      <QrSvg payload={payload} label={alt} onFailed={() => setFailed(true)} />
    </Suspense>
  );
}
