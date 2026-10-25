/**
 * Order page: the paid pop-up and the slip-check progress pop-up.
 */
import { useEffect, useRef } from 'react';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import type { SlipProgressPhase } from '../../model/slip-progress.ts';
import { useT } from '../app-context.tsx';

/** The bottom sheet every pop-up here uses: focus on open, Escape or the scrim closes it. */
export function PopupShell({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
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
        aria-labelledby={titleId}
        style={s('align-items:center;gap:10px;text-align:center')}
      >
        {children}
      </div>
    </div>
  );
}

/** Rises from the bottom when the shop confirms the transfer while the page is open. */
export function PaidPopup({ orderNo, onClose }: { orderNo: string; onClose: () => void }) {
  const tr = useT();
  return (
    <PopupShell titleId="paid-popup-title" onClose={onClose}>
      <Gi n="check" size="lg" style={{ color: 'var(--jade)' }} />
      <h2 id="paid-popup-title" className="g-t-2" style={s('margin:0')}>
        {tr('liff.paidPopup.title')}
      </h2>
      <p className="g-t-3" style={s('margin:0')}>
        {tr('liff.paidPopup.body')}
      </p>
      <p className="g-num g-t-c" style={s('margin:0')}>
        {tr('liff.paidPopup.order', { orderNo })}
      </p>
      <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
        {tr('liff.close')}
      </button>
    </PopupShell>
  );
}

/**
 * Opens when the customer sends a slip and follows the check in the same pop-up: moving bar, then
 * "money received" (at once), "the amount does not match" (the one failure named), "the slip is
 * valid, the shop is confirming", or the neutral "the shop is checking" for everything else. It can be
 * closed at any time; the check goes on and the page keeps showing the status.
 */
export function SlipProgressPopup({
  phase,
  orderNo,
  slowHint = false,
  onClose,
}: {
  phase: SlipProgressPhase;
  orderNo: string;
  /** Adds the "may take about a minute" line; the caller decides when (checking phase only). */
  slowHint?: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <PopupShell titleId="slip-progress-title" onClose={onClose}>
      <div
        aria-live="polite"
        style={s('display:flex;flex-direction:column;align-items:center;gap:10px;width:100%')}
      >
        {phase === 'paid' ? (
          <>
            <Gi n="check" size="lg" style={{ color: 'var(--jade)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.paidPopup.title')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.paidPopup.body')}
            </p>
            <p className="g-num g-t-c" style={s('margin:0')}>
              {tr('liff.paidPopup.order', { orderNo })}
            </p>
          </>
        ) : phase === 'amount_mismatch' ? (
          <>
            <Gi n="warn" size="lg" style={{ color: 'var(--ink2)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.mismatchTitle')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.mismatchBody')}
            </p>
          </>
        ) : phase === 'verified_waiting' ? (
          <>
            <Gi n="check" size="lg" style={{ color: 'var(--ink2)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.waitingTitle')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.waitingBody')}
            </p>
          </>
        ) : phase === 'staff_review' ? (
          <>
            <Gi n="clock" size="lg" style={{ color: 'var(--ink2)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.staffTitle')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.staffBody')}
            </p>
          </>
        ) : (
          <>
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.title')}
            </h2>
            <div
              className="liff-progress"
              role="progressbar"
              aria-label={tr('liff.slipProgress.label')}
            >
              <span />
            </div>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.hint')}
            </p>
            {slowHint && phase === 'checking' ? (
              <p id="slip-progress-slow" className="g-t-c" style={s('margin:0')}>
                {tr('liff.slipProgress.slowHint')}
              </p>
            ) : null}
          </>
        )}
      </div>
      <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
        {tr('liff.close')}
      </button>
    </PopupShell>
  );
}
