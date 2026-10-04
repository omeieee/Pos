import type { MessageKey } from '@sds/i18n';
import type { ReactNode } from 'react';
import { DialogLayout } from '../ui/DialogParts.tsx';
import { useActivityHold, useT } from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';
import './menu-glass.css';

/**
 * The frame of every editor dialog: a title, the fields, the failure of the last save, and the
 * cancel / save buttons. iPad: a card over the page; iPhone: a sheet from the bottom (the
 * `options` Modal variant). The fields scroll inside the frame, so the buttons stay in reach with
 * the keyboard open. While it is open the app counts as busy, so a waiting update never reloads
 * the page under a half-typed form.
 */
export function DialogFrame({
  titleKey,
  saving,
  disabled,
  error,
  onClose,
  onSubmit,
  children,
}: {
  titleKey: MessageKey;
  saving: boolean;
  /** Save is off (offline). */
  disabled: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const tr = useT();
  useActivityHold(true);
  return (
    <PortalModal labelledBy="medit-title" onClose={onClose} variant="options">
      <DialogLayout
        titleId="medit-title"
        title={tr(titleKey)}
        onClose={onClose}
        onSubmit={onSubmit}
        error={error}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button type="submit" className="g-btn g-btn-p g-btn-lg" disabled={saving || disabled}>
              {saving ? tr('menuEditor.saving') : tr('common.save')}
            </button>
          </>
        }
      >
        {children}
      </DialogLayout>
    </PortalModal>
  );
}
