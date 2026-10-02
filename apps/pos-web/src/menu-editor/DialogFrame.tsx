import type { MessageKey } from '@sds/i18n';
import type { ReactNode } from 'react';
import { useActivityHold, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';

/**
 * The frame of every editor dialog: a title, the fields, the failure of the last save, and the
 * cancel / save buttons. iPad: a card over the page; iPhone: a sheet from the bottom (the
 * `options` Modal variant). While it is open the app counts as busy, so a waiting update never
 * reloads the page under a half-typed form.
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
    <Modal labelledBy="medit-title" onClose={onClose} variant="options">
      <form
        className="mdialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className="osheet__head">
          <h2 id="medit-title" className="sheet__title">
            {tr(titleKey)}
          </h2>
          <button
            type="button"
            className="btn btn-soft"
            aria-label={tr('common.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="osheet__body">{children}</div>
        <footer className="osheet__foot">
          <div className="error-slot" role="alert">
            {error ? <p className="error">{error}</p> : null}
          </div>
          <div className="osheet__actions">
            <button type="button" className="btn btn-soft btn-lg" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-lg osheet__confirm"
              disabled={saving || disabled}
            >
              {saving ? tr('menuEditor.saving') : tr('common.save')}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
