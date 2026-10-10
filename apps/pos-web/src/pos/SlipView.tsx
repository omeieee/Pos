import { useEffect, useState } from 'react';
import { s } from '../design/style.ts';
import { useServices, useT } from '../ui/hooks.ts';

/**
 * The customer's slip for a claimed payment. The payment list answer says which payments have a
 * picture, so the button shows only then; it is asked again whenever the payment changes (a slip
 * comes with the claim, which is a new revision). Staff open the picture on request; it comes with
 * the session header, lives in a blob URL for as long as it is shown and is never stored. It is only
 * a hint: the money is confirmed from the bank app (rule 2).
 */
export function SlipView({
  orderId,
  paymentId,
  rev,
}: {
  orderId: string;
  paymentId: string;
  rev: number;
}) {
  const tr = useT();
  const { api } = useServices();
  // `unknown`: the list could not be read, so the button is offered as before.
  const [known, setKnown] = useState<'checking' | 'has' | 'missing' | 'unknown'>('checking');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle');
  const [url, setUrl] = useState<string | null>(null);

  // `rev` is a dependency on purpose: a new revision of the payment may mean a slip arrived.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    api.payments
      .list(orderId)
      .then((answer) => {
        if (live) setKnown(answer.slipPaymentIds?.includes(paymentId) ? 'has' : 'missing');
      })
      .catch(() => {
        if (live) setKnown('unknown');
      });
    return () => {
      live = false;
    };
  }, [api, orderId, paymentId, rev]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  async function open() {
    setPhase('loading');
    try {
      setUrl(URL.createObjectURL(await api.payments.slip(paymentId)));
      setPhase('idle');
    } catch (error) {
      setPhase((error as { code?: string }).code === 'SLIP_NOT_FOUND' ? 'none' : 'failed');
    }
  }

  if (known === 'checking') return null;
  if (known === 'missing') {
    return (
      <p className="g-t-c" role="status" data-testid="slip-missing" style={s('margin:0')}>
        {tr('payment.slip.missing')}
      </p>
    );
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
      {known === 'has' ? (
        <p className="g-t-c" data-testid="slip-has" style={s('margin:0;font-weight:600')}>
          {tr('payment.slip.has')}
        </p>
      ) : null}
      {url ? (
        <>
          <img
            src={url}
            alt={tr('payment.slip.alt')}
            style={s('max-width:100%;max-height:60vh;object-fit:contain;border-radius:12px')}
          />
          <p className="g-t-c" style={s('margin:0')}>
            {tr('payment.slip.warning')}
          </p>
        </>
      ) : (
        <button
          type="button"
          className="g-btn g-btn-sm"
          disabled={phase === 'loading'}
          onClick={() => void open()}
        >
          {tr('payment.slip.view')}
        </button>
      )}
      {phase === 'none' ? (
        <p className="g-t-c" role="status" style={s('margin:0')}>
          {tr('payment.slip.none')}
        </p>
      ) : null}
      {phase === 'failed' ? (
        <p className="g-t-c" role="alert" style={s('margin:0')}>
          {tr('payment.slip.failed')}
        </p>
      ) : null}
    </div>
  );
}
