import { useState } from 'react';
import { errorText } from '../api/errors.ts';
import { stepUpMethodFor } from '../auth/auth-store.ts';
import {
  afterFailedAttempt,
  emptyOwnerDraft,
  type OwnerDraft,
  ownerStepUpRequest,
} from '../auth/owner-form.ts';
import { s } from '../design/style.ts';
import { DialogLayout } from './DialogParts.tsx';
import { useAuthState, useAuthStore, useT } from './hooks.ts';
import { Modal } from './Modal.tsx';
import { OwnerFields } from './OwnerFields.tsx';
import { PinPad } from './PinPad.tsx';

/**
 * Asks the person to prove who they are again before a sensitive action. The factor follows the
 * role: the owner gives the password and a code, everyone else their PIN. It is reusable: any
 * code path calls `auth.runSensitive(...)` or `auth.ensureStepUp()` and this dialog (mounted once
 * at the root) appears.
 */
export function StepUpDialog() {
  const state = useAuthState();
  const role = state.session?.staff.role;
  if (!state.stepUpOpen || !role) return null;
  return <StepUpForm role={role} />;
}

function StepUpForm({
  role,
}: {
  role: NonNullable<ReturnType<typeof useAuthState>['session']>['staff']['role'];
}) {
  const auth = useAuthStore();
  const tr = useT();
  const method = stepUpMethodFor(role);
  const [draft, setDraft] = useState<OwnerDraft>(emptyOwnerDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  async function submitOwner() {
    const factors = ownerStepUpRequest(draft);
    if (!factors || busy) return;
    setBusy(true);
    setError(null);
    const result = await auth.submitStepUp({ method: 'owner', factors });
    // A swallowed duplicate leaves the busy state to the attempt that is still running.
    if (!result.ok && result.duplicate) return;
    setBusy(false);
    if (!result.ok && result.error) {
      setError(errorText(tr, result.error, 'stepUp'));
      setDraft(afterFailedAttempt(draft));
    }
  }

  async function submitPin(pin: string) {
    setBusy(true);
    setError(null);
    const result = await auth.submitStepUp({ method: 'pin', pin });
    // A swallowed duplicate leaves the busy state to the attempt that is still running.
    if (!result.ok && result.duplicate) return;
    setBusy(false);
    if (!result.ok && result.error) {
      setError(errorText(tr, result.error, 'stepUp'));
      setAttempt((n) => n + 1);
    }
  }

  const hint = method === 'owner' ? tr('auth.stepUp.ownerHint') : tr('auth.stepUp.pinHint');
  const cancel = (
    <button type="button" className="g-btn g-btn-lg" onClick={() => auth.cancelStepUp()}>
      {tr('common.cancel')}
    </button>
  );

  return (
    <Modal labelledBy="stepup-title" onClose={() => auth.cancelStepUp()}>
      {method === 'owner' ? (
        <DialogLayout
          titleId="stepup-title"
          title={tr('auth.stepUp.title')}
          subtitle={hint}
          onClose={() => auth.cancelStepUp()}
          onSubmit={() => void submitOwner()}
          error={error}
          actions={
            <>
              {cancel}
              <button
                type="submit"
                className="g-btn g-btn-p g-btn-lg"
                disabled={busy || ownerStepUpRequest(draft) === null}
              >
                {tr('auth.stepUp.submit')}
              </button>
            </>
          }
        >
          <OwnerFields draft={draft} onChange={setDraft} withEmail={false} disabled={busy} />
        </DialogLayout>
      ) : (
        <DialogLayout
          titleId="stepup-title"
          title={tr('auth.stepUp.title')}
          subtitle={hint}
          onClose={() => auth.cancelStepUp()}
          actions={cancel}
        >
          <div style={s('padding-top:4px')}>
            <PinPad
              key={attempt}
              role={role}
              disabled={busy}
              error={error}
              submitLabel={tr('auth.stepUp.submit')}
              onSubmit={submitPin}
            />
          </div>
        </DialogLayout>
      )}
    </Modal>
  );
}
