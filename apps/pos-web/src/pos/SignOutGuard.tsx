import { DialogLayout } from '../ui/DialogParts.tsx';
import { useT } from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';

/**
 * Signing out with orders or cash that are not sent yet: they are kept (not lost), but they are
 * sent only when this person signs in again, and signing in needs the internet. Said before, not
 * after, because a cashier who signs out at a dead connection cannot get back in.
 *
 * It is drawn at the top of the app: the navigation rail and the sidebar that hold the account
 * menu are frosted glass, and a dialog left inside one would open inside that narrow strip.
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
    <PortalModal labelledBy="signout-queue-title" onClose={onCancel}>
      <DialogLayout
        titleId="signout-queue-title"
        title={tr('shell.signOut.queueTitle')}
        onClose={onCancel}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" onClick={onSignOut}>
              {tr('shell.signOut.confirm')}
            </button>
            <button type="button" className="g-btn g-btn-p g-btn-lg" onClick={onCancel}>
              {tr('shell.signOut.stay')}
            </button>
          </>
        }
      >
        <p className="g-t-b" style={{ margin: 0 }}>
          {tr('shell.signOut.queueBody', { count })}
        </p>
      </DialogLayout>
    </PortalModal>
  );
}
