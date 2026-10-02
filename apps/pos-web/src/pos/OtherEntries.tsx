import { useContext, useState } from 'react';
import type { AuthStore } from '../auth/auth-store.ts';
import { AuthContext, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';

type Action = 'takeOver' | 'clear';

/**
 * The entries other people left on this device: a count, never their contents (an order carries a
 * recipient's name). For everyone but the owner that is all there is. The owner can also take them
 * over (they then replay under the owner's session, and the server records the owner as the
 * creator) or clear them. Both ask for the step-up first and then for a confirmation that names
 * the count.
 */
export function OtherEntries() {
  const tr = useT();
  const auth = useContext(AuthContext);
  const state = useStoreState(useServices().outbox);
  const { othersCount: count, recovered } = state;
  return (
    <div className="others">
      {count > 0 ? (
        <p className="notice" role="status">
          <Icon name="info" />
          <span>{tr('outbox.others', { count })}</span>
        </p>
      ) : null}
      {auth ? <OwnerRecovery auth={auth} count={count} /> : null}
      {recovered ? (
        <p className="notice" role="status">
          <Icon name="check-circle" />
          <span>
            {tr(
              recovered.action === 'takeOver'
                ? 'outbox.others.done.takeOver'
                : 'outbox.others.done.clear',
              { count: recovered.count },
            )}
            {recovered.failed > 0
              ? ` ${tr('outbox.others.failed', { count: recovered.failed })}`
              : ''}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function OwnerRecovery({ auth, count }: { auth: AuthStore; count: number }) {
  const tr = useT();
  const { outbox } = useServices();
  const owner = useStoreState(auth).session?.staff.role === 'owner';
  const [asking, setAsking] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function run(action: Action) {
    setBusy(true);
    setForbidden(false);
    // The step-up comes first, then the action: cancelling it changes nothing.
    const done = await auth.runSensitive(() =>
      action === 'takeOver' ? outbox.takeOverOthers() : outbox.clearOthers(),
    );
    setBusy(false);
    setAsking(null);
    if (done.ok && !done.value.ok) setForbidden(true);
  }

  if (!owner) return null;
  return (
    <>
      {count > 0 ? (
        <div className="qactions__row">
          <button type="button" className="btn btn-primary" onClick={() => setAsking('takeOver')}>
            {tr('outbox.others.takeOver')}
          </button>
          <button type="button" className="btn btn-soft" onClick={() => setAsking('clear')}>
            {tr('outbox.others.clear')}
          </button>
        </div>
      ) : null}
      {forbidden ? (
        <p className="error" role="alert">
          {tr('outbox.others.forbidden')}
        </p>
      ) : null}
      {asking ? (
        <Modal labelledBy="others-title" onClose={() => (busy ? undefined : setAsking(null))}>
          <h2 id="others-title" className="sheet__title">
            {tr(
              asking === 'takeOver' ? 'outbox.others.takeOver.title' : 'outbox.others.clear.title',
              { count },
            )}
          </h2>
          <p>
            {tr(asking === 'takeOver' ? 'outbox.others.takeOver.body' : 'outbox.others.clear.body')}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() => setAsking(null)}
          >
            {tr('outbox.discard.keep')}
          </button>
          <button
            type="button"
            className={asking === 'clear' ? 'btn btn-danger btn-block' : 'btn btn-block'}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void run(asking)}
          >
            {tr(
              asking === 'takeOver'
                ? 'outbox.others.takeOver.confirm'
                : 'outbox.others.clear.confirm',
            )}
          </button>
        </Modal>
      ) : null}
    </>
  );
}
