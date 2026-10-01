import { type FormEvent, useState } from 'react';
import type { OwnerLoginRequest } from '../api/client.ts';
import { errorText } from '../api/errors.ts';
import type { Result } from '../auth/auth-store.ts';
import {
  afterFailedAttempt,
  emptyOwnerDraft,
  type OwnerDraft,
  ownerLoginRequest,
  sanitizeAppCode,
} from '../auth/owner-form.ts';
import { useT } from './hooks.ts';
import { TextField } from './TextField.tsx';

/**
 * Password plus one second factor (the app's 6-digit code or a recovery code). With `withEmail`
 * it is the sign-in form; without, the step-up form (the session already knows who the owner is).
 */
export function OwnerFields({
  draft,
  onChange,
  withEmail,
  disabled,
}: {
  draft: OwnerDraft;
  onChange: (next: OwnerDraft) => void;
  withEmail: boolean;
  disabled: boolean;
}) {
  const tr = useT();
  return (
    <>
      {withEmail ? (
        <TextField
          label={tr('auth.owner.email')}
          type="email"
          inputMode="email"
          autoComplete="username"
          value={draft.email}
          disabled={disabled}
          onChange={(email) => onChange({ ...draft, email })}
        />
      ) : null}
      <TextField
        label={tr('auth.owner.password')}
        type="password"
        autoComplete="current-password"
        value={draft.password}
        disabled={disabled}
        onChange={(password) => onChange({ ...draft, password })}
      />
      {draft.useRecovery ? (
        <TextField
          label={tr('auth.owner.recoveryCode')}
          autoComplete="off"
          value={draft.recoveryCode}
          disabled={disabled}
          onChange={(recoveryCode) => onChange({ ...draft, recoveryCode })}
        />
      ) : (
        <TextField
          label={tr('auth.owner.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={draft.code}
          disabled={disabled}
          onChange={(raw) => onChange({ ...draft, code: sanitizeAppCode(raw) })}
        />
      )}
      <button
        type="button"
        className="link"
        disabled={disabled}
        onClick={() => onChange({ ...draft, useRecovery: !draft.useRecovery })}
      >
        {draft.useRecovery ? tr('auth.owner.useCode') : tr('auth.owner.useRecovery')}
      </button>
    </>
  );
}

/** The owner's sign-in form: e-mail, password, code. Says the same thing for every failure. */
export function OwnerSignInForm({
  onSubmit,
  submitLabel,
}: {
  onSubmit: (request: OwnerLoginRequest) => Promise<Result>;
  submitLabel: string;
}) {
  const tr = useT();
  const [draft, setDraft] = useState<OwnerDraft>(emptyOwnerDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = ownerLoginRequest(draft);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    const result = await onSubmit(request);
    setBusy(false);
    if (!result.ok && result.error) {
      setError(errorText(tr, result.error, 'ownerSignIn'));
      setDraft(afterFailedAttempt(draft));
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <OwnerFields draft={draft} onChange={setDraft} withEmail disabled={busy} />
      <div className="error-slot">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        className="btn btn-primary btn-lg btn-block"
        disabled={busy || request === null}
      >
        {submitLabel}
      </button>
    </form>
  );
}
