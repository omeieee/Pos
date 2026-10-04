import { lazy, Suspense, useState } from 'react';
import { s } from '../design/style.ts';
import { useT } from '../ui/hooks.ts';
import { Callout } from './PayParts.tsx';

const QrSvg = lazy(() => import('./QrSvg.tsx'));

/**
 * The offline PromptPay QR: drawn on this device from the payload, no request, no picture address.
 * The drawing code loads when this first shows (a separate chunk, kept in the offline precache).
 * `alt` is the amount in words and nothing else: the payload holds the shop's account number.
 */
export function LocalQr({
  payload,
  alt,
  size = 250,
}: {
  payload: string;
  alt: string;
  /** The width of the picture. */
  size?: number;
}) {
  const tr = useT();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <Callout tone="bad" role="alert">
        {tr('payment.offlineQr.failed')}
      </Callout>
    );
  }
  return (
    <Suspense
      fallback={
        <div
          role="status"
          style={s(
            `width:min(100%,${size}px);aspect-ratio:1;display:grid;place-items:center;margin:0 auto`,
          )}
        >
          <span className="g-t-s">{tr('payment.offlineQr.loading')}</span>
        </div>
      }
    >
      <QrSvg payload={payload} label={alt} size={size} onFailed={() => setFailed(true)} />
    </Suspense>
  );
}
