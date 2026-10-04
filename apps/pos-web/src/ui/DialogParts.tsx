import type { ReactNode } from 'react';
import { Gi } from '../design/icons.tsx';
import { useT } from './hooks.ts';
import './glass-forms.css';

/**
 * The inside of a dialog (put it in the shared Modal): a title with a close button, a body that
 * scrolls on its own (so a long form never pushes the buttons off a small screen or behind the
 * keyboard), and a footer with the failure of the last try and the buttons. With `onSubmit` it is
 * a form, so Enter in a field sends it.
 */
export function DialogLayout({
  titleId,
  title,
  subtitle,
  onClose,
  onSubmit,
  error,
  actions,
  children,
}: {
  titleId: string;
  title: string;
  subtitle?: string | undefined;
  onClose: () => void;
  onSubmit?: (() => void) | undefined;
  /** The failure of the last try (null: none). Pass `undefined` for a dialog that never shows one. */
  error?: string | null | undefined;
  actions: ReactNode;
  children: ReactNode;
}) {
  const tr = useT();
  const inner = (
    <>
      <header className="gdlg__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id={titleId} className="gdlg__title">
            {title}
          </h2>
          {subtitle ? <p className="g-t-s gdlg__sub">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="g-btn g-btn-icon"
          style={{ flex: 'none' }}
          aria-label={tr('common.close')}
          onClick={onClose}
        >
          <Gi n="x" />
        </button>
      </header>
      <div className="gdlg__body g-scroll">{children}</div>
      <footer className="gdlg__foot">
        {error === undefined ? null : (
          <div className="gdlg__alert" role="alert">
            {error ? (
              <p className="gfield__msg gfield__msg--bad" style={{ paddingLeft: 0 }}>
                <Gi n="warn" />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        )}
        <div className="gdlg__actions">{actions}</div>
      </footer>
    </>
  );
  return onSubmit ? (
    <form
      className="gdlg"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {inner}
    </form>
  ) : (
    <div className="gdlg">{inner}</div>
  );
}
