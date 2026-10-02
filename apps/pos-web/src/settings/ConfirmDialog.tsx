import { useActivityHold, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';

/**
 * A question before something that is hard to take back (removing a device, deactivating a
 * person). Nothing happens until the confirm button; closing or cancelling changes nothing.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  useActivityHold(true);
  return (
    <Modal labelledBy="confirm-title" onClose={onClose} variant="options">
      <div className="mdialog">
        <header className="osheet__head">
          <h2 id="confirm-title" className="sheet__title">
            {title}
          </h2>
        </header>
        <div className="osheet__body">
          <p>{body}</p>
        </div>
        <footer className="osheet__foot">
          <div className="error-slot" role="alert">
            {error ? <p className="error">{error}</p> : null}
          </div>
          <div className="osheet__actions">
            <button type="button" className="btn btn-soft btn-lg" disabled={busy} onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-lg osheet__confirm"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? tr('settings.staff.working') : confirmLabel}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
