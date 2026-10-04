import { useContext, useState } from 'react';
import { errorText } from '../api/errors.ts';
import type { AuthStore } from '../auth/auth-store.ts';
import { s } from '../design/style.ts';
import { AuthContext, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout, PayModal, SheetBody, SheetTitle } from './PayParts.tsx';

type Action = 'takeOver' | 'clear';

/**
 * The entries other people left on this device: a count, never their contents (an order carries a
 * recipient's name). For everyone but the owner that is all there is. The owner can also take them
 * over (they then replay under the owner's session, and the server records the owner as the
 * creator and keeps the original staff member's name) or clear them. Both need the internet (the
 * server writes the audit first), ask for the step-up and then for a confirmation that names the
 * count. Whatever stops it is said on screen: a closed step-up, no connection, a refusal.
 */
export function OtherEntries() {
  const tr = useT();
  const auth = useContext(AuthContext);
  const state = useStoreState(useServices().outbox);
  const { othersCount: count, recovered } = state;
  return (
    <div style={s('display:flex;flex-direction:column;gap:10px')}>
      {count > 0 ? (
        <Callout tone="info" role="status">
          {tr('outbox.others', { count })}
        </Callout>
      ) : null}
      {auth ? <OwnerRecovery auth={auth} count={count} /> : null}
      {recovered ? (
        <Callout tone="ok" role="status">
          {tr(
            recovered.action === 'takeOver'
              ? 'outbox.others.done.takeOver'
              : 'outbox.others.done.clear',
            { count: recovered.count },
          )}
          {recovered.failed > 0
            ? ` ${tr('outbox.others.failed', { count: recovered.failed })}`
            : ''}
        </Callout>
      ) : null}
    </div>
  );
}

function OwnerRecovery({ auth, count }: { auth: AuthStore; count: number }) {
  const tr = useT();
  const { outbox } = useServices();
  const offline = useStoreState(outbox).offline;
  const owner = useStoreState(auth).session?.staff.role === 'owner';
  const [asking, setAsking] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Offline there is nobody to record it with: say so now, before a password is asked for. */
  function ask(action: Action) {
    if (offline) {
      setProblem(tr('outbox.others.offline'));
      return;
    }
    setProblem(null);
    setAsking(action);
  }

  async function run(action: Action) {
    setBusy(true);
    setProblem(null);
    // The step-up comes first, then the action: cancelling it changes nothing.
    const done = await auth.runSensitive(() =>
      action === 'takeOver' ? outbox.takeOverOthers() : outbox.clearOthers(),
    );
    setBusy(false);
    setAsking(null);
    if (!done.ok) {
      // No error: the owner closed the step-up. Anything else is the server's own answer.
      if (done.duplicate) return;
      setProblem(done.error === null ? tr('error.ownerSignInNeeded') : errorText(tr, done.error));
      return;
    }
    const result = done.value;
    if (result.ok) return;
    setProblem(
      result.reason === 'offline'
        ? tr('outbox.others.offline')
        : result.reason === 'error'
          ? errorText(tr, result.error)
          : tr('outbox.others.forbidden'),
    );
  }

  if (!owner) return null;
  return (
    <>
      {count > 0 ? (
        <div style={s('display:flex;gap:10px;flex-wrap:wrap')}>
          <button type="button" className="g-btn g-btn-p" onClick={() => ask('takeOver')}>
            {tr('outbox.others.takeOver')}
          </button>
          <button type="button" className="g-btn" onClick={() => ask('clear')}>
            {tr('outbox.others.clear')}
          </button>
        </div>
      ) : null}
      {problem ? (
        <Callout tone="bad" role="alert">
          {problem}
        </Callout>
      ) : null}
      {asking ? (
        <PayModal labelledBy="others-title" onClose={() => (busy ? undefined : setAsking(null))}>
          <SheetBody>
            <SheetTitle id="others-title">
              {tr(
                asking === 'takeOver'
                  ? 'outbox.others.takeOver.title'
                  : 'outbox.others.clear.title',
                { count },
              )}
            </SheetTitle>
            <p className="g-t-s" style={s('margin:0')}>
              {tr(
                asking === 'takeOver' ? 'outbox.others.takeOver.body' : 'outbox.others.clear.body',
              )}
            </p>
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              disabled={busy}
              onClick={() => setAsking(null)}
            >
              {tr('outbox.discard.keep')}
            </button>
            <button
              type="button"
              className="g-btn g-btn-block"
              style={s(asking === 'clear' ? 'color:var(--chili-ink)' : '')}
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
          </SheetBody>
        </PayModal>
      ) : null}
    </>
  );
}
