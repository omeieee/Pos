/**
 * Order page: the full-screen QR picture.
 */
import { useEffect, useRef } from 'react';
import { s } from '../../design/style.ts';
import { useT } from '../app-context.tsx';

/** The QR as a large picture on its own, so "press and hold to save" has a big, plain target. */
export function QrViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const tr = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay liff-overlay" role="presentation">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="liff-scrim"
        onClick={onClose}
      />
      <div
        ref={dialog}
        tabIndex={-1}
        className="sheet liff-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={tr('liff.qr.title')}
        style={s('align-items:center;gap:14px')}
      >
        <img
          src={src}
          alt={alt}
          style={s('width:min(100%,360px);aspect-ratio:1;background:#fff;border-radius:16px')}
        />
        <p className="g-t-s" role="status" style={s('margin:0;text-align:center')}>
          {tr('liff.qr.holdToSave')}
        </p>
        <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
          {tr('liff.close')}
        </button>
      </div>
    </div>
  );
}
