import { useEffect, useState } from 'react';
import { s } from '../design/style.ts';
import { useServices, useT } from '../ui/hooks.ts';

/**
 * The customer's slip for a claimed payment. Staff open it on request; the picture comes with the
 * session header, lives in a blob URL for as long as it is shown and is never stored. It is only a
 * hint: the money is confirmed from the bank app (rule 2).
 */
export function SlipView({ paymentId }: { paymentId: string }) {
  const tr = useT();
  const { api } = useServices();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle');
  const [url, setUrl] = useState<string | null>(null);

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

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
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
