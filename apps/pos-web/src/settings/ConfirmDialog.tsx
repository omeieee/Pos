import { DialogLayout } from '../ui/DialogParts.tsx';
import { useActivityHold, useT } from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';
import './settings-glass.css';

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
    <PortalModal labelledBy="confirm-title" onClose={onClose}>
      <DialogLayout
        titleId="confirm-title"
        title={title}
        onClose={onClose}
        error={error}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" disabled={busy} onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? tr('settings.staff.working') : confirmLabel}
            </button>
          </>
        }
      >
        <p className="g-t-b" style={{ margin: 0 }}>
          {body}
        </p>
      </DialogLayout>
    </PortalModal>
  );
}
