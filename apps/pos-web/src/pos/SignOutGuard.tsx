import { useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';

/**
 * Signing out with orders or cash that are not sent yet: they are kept (not lost), but they are
 * sent only when this person signs in again, and signing in needs the internet. Said before, not
 * after, because a cashier who signs out at a dead connection cannot get back in.
 */
export function SignOutGuard({
  count,
  onCancel,
  onSignOut,
}: {
  count: number;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  const tr = useT();
  return (
    <Modal labelledBy="signout-queue-title" onClose={onCancel}>
      <h2 id="signout-queue-title" className="sheet__title">
        {tr('shell.signOut.queueTitle')}
      </h2>
      <p>{tr('shell.signOut.queueBody', { count })}</p>
      <button type="button" className="btn btn-primary btn-block" onClick={onCancel}>
        {tr('shell.signOut.stay')}
      </button>
      <button type="button" className="btn btn-soft btn-block" onClick={onSignOut}>
        {tr('shell.signOut.confirm')}
      </button>
    </Modal>
  );
}
