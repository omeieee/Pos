import { useEffect, useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { s } from '../design/style.ts';
import { useEntities, useServices, useT } from '../ui/hooks.ts';
import { Callout } from './PayParts.tsx';

/**
 * How long a signed QR link is used before asking for a new one. A link lives five minutes (the
 * server's rule); one is replaced after four so the picture never goes stale in front of a
 * customer. Measured from when it ARRIVED on this device, so a skewed iPad clock cannot break it.
 */
const REFRESH_AFTER_MS = 4 * 60_000;
/** A refresh that failed is tried again soon; the picture on screen is still good for a while. */
const RETRY_AFTER_MS = 20_000;

type QrState =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string; target: string }
  | { phase: 'failed'; error: unknown };

/**
 * The PromptPay QR picture of a waiting payment.
 *
 * The picture is an `<img>`, which cannot send a header, so its address carries a short-lived
 * signature: that address is a CREDENTIAL. It is held in this component's memory only. It is never
 * logged, never written to storage or the outbox, never put in an error message, the page address
 * or the picture's alt text. A new one is fetched whenever the QR is shown (every mount), when the
 * shop's PromptPay ID changes (`promptpayRev`), before the old one expires, and when the app comes
 * back to the front.
 *
 * A picture that fails to load usually means the link expired (the server answers 410, which an
 * `<img>` cannot read): one new link is asked for, and if that picture fails too it stops and
 * offers a reload button, so a payment that is no longer waiting (another device confirmed it) can
 * never cause a loop.
 *
 * Only the picture is drawn here (inside the white card of the design). The masked account the link
 * was made for is handed to `onTarget`, so the caller can write it where it belongs.
 */
export function PromptPayQr({
  paymentId,
  alt,
  size = 250,
  onTarget,
}: {
  paymentId: string;
  alt: string;
  /** The width of the picture; it never grows past the room it has. */
  size?: number;
  /** Told the masked PromptPay ID the current picture pays to (null while there is none). */
  onTarget?: (target: string | null) => void;
}) {
  const { api, lifecycle } = useServices();
  const promptpayRev = useEntities().promptpayRev;
  const tr = useT();
  const [state, setState] = useState<QrState>({ phase: 'loading' });
  const [reloads, setReloads] = useState(0);
  const hasLink = useRef(false);
  const retriedOnError = useRef(false);

  // `reloads` and `promptpayRev` re-run the fetch on purpose.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    api.payments.qrUrl(paymentId).then(
      (link) => {
        if (!live) return;
        hasLink.current = true;
        setState({ phase: 'ready', url: link.url, target: link.promptpayTargetMasked });
        timer = setTimeout(() => setReloads((n) => n + 1), REFRESH_AFTER_MS);
      },
      (error: unknown) => {
        if (!live) return;
        if (hasLink.current) {
          // Keep showing the picture we have and try again soon.
          timer = setTimeout(() => setReloads((n) => n + 1), RETRY_AFTER_MS);
        } else {
          setState({ phase: 'failed', error });
        }
      },
    );
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, paymentId, promptpayRev, reloads]);

  const target = state.phase === 'ready' ? state.target : null;
  useEffect(() => {
    onTarget?.(target);
  }, [target, onTarget]);

  // The iPad was in the background for a while: the link may have expired meanwhile.
  useEffect(() => lifecycle.subscribe({ visible: () => setReloads((n) => n + 1) }), [lifecycle]);

  const frame = s(
    `width:min(100%,${size}px);aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;margin:0 auto`,
  );
  if (state.phase === 'failed') {
    return (
      <div style={frame}>
        <Callout tone="bad" role="alert">
          {state.error ? errorText(tr, state.error, 'payment') : tr('payment.promptpay.qrFailed')}
        </Callout>
        <button
          type="button"
          className="g-btn"
          onClick={() => {
            retriedOnError.current = false;
            hasLink.current = false;
            setState({ phase: 'loading' });
            setReloads((n) => n + 1);
          }}
        >
          {tr('payment.promptpay.reloadQr')}
        </button>
      </div>
    );
  }
  if (state.phase === 'loading') {
    return (
      <div style={frame} role="status">
        <span className="g-t-s">{tr('payment.promptpay.loadingQr')}</span>
      </div>
    );
  }

  return (
    <img
      className="pay-qr"
      style={s(`display:block;width:min(100%,${size}px);aspect-ratio:1;margin:0 auto`)}
      src={state.url}
      alt={alt}
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => {
        retriedOnError.current = false;
      }}
      onError={() => {
        if (retriedOnError.current) {
          hasLink.current = false;
          setState({ phase: 'failed', error: null });
        } else {
          retriedOnError.current = true;
          setReloads((n) => n + 1);
        }
      }}
    />
  );
}
