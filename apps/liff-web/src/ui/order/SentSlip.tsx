/**
 * Order page: the slip the customer sent (picture, state, re-send).
 */
import { useEffect, useState } from 'react';
import { s } from '../../design/style.ts';
import { useApp, useT } from '../app-context.tsx';

/**
 * The slip this customer sent, on request. It is fetched with the session header (an `<img>` cannot
 * send one), shown from a `blob:` link and never stored. Only the picture they sent: nothing the
 * shop's system read from it.
 */
export function SentSlip({ orderId, stamp }: { orderId: string; stamp: number }) {
  const tr = useT();
  const { api } = useApp();
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed'>('idle');

  // A new slip (or another order) makes the old picture on show stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is the trigger
  useEffect(() => {
    setSrc(null);
    setPhase('idle');
  }, [orderId, stamp]);
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function open() {
    setPhase('loading');
    try {
      setSrc(URL.createObjectURL(await api.slip(orderId)));
      setPhase('idle');
    } catch {
      setPhase('failed');
    }
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
      {src ? (
        <>
          <img
            src={src}
            alt={tr('liff.slip.alt')}
            style={s('max-width:100%;max-height:60vh;object-fit:contain;border-radius:12px')}
          />
          <button type="button" className="g-btn g-btn-sm" onClick={() => setSrc(null)}>
            {tr('liff.slip.hide')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="g-btn g-btn-sm"
          disabled={phase === 'loading'}
          onClick={() => void open()}
        >
          {tr('liff.slip.view')}
        </button>
      )}
      {phase === 'failed' ? (
        <p className="g-t-c" role="alert" style={s('margin:0')}>
          {tr('liff.slip.loadFailed')}
        </p>
      ) : null}
    </div>
  );
}
