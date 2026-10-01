import type { DeviceKind } from '@sds/shared';
import { type FormEvent, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { suggestedKind } from '../theme/device.ts';
import { Brand } from './Brand.tsx';
import { useAuthState, useAuthStore, useT, useViewport } from './hooks.ts';
import { Notice } from './Notice.tsx';
import { OwnerSignInForm } from './OwnerFields.tsx';
import { TextField } from './TextField.tsx';

/** pos-web runs on these; a print agent or a display registers from its own app. */
const KINDS = ['ipad', 'iphone', 'laptop'] as const satisfies readonly DeviceKind[];

/**
 * First run on an unregistered device: the owner signs in, then names the device. Registering is
 * a sensitive action, so the step-up dialog appears when the person presses the button.
 */
export function RegisterDeviceScreen() {
  const state = useAuthState();
  const auth = useAuthStore();
  const tr = useT();
  const signedIn = state.session !== null;

  return (
    <main className="auth">
      <div className="card">
        <header className="card__head">
          <Brand />
        </header>
        <Notice notice={state.notice} />
        <h1 className="card__title">{tr('auth.register.title')}</h1>
        <p className="muted">{tr('auth.register.intro')}</p>
        <h2 className="step">{signedIn ? tr('auth.register.step2') : tr('auth.register.step1')}</h2>
        {state.session ? (
          <NameDevice signedInName={state.session.staff.displayName} />
        ) : (
          <OwnerSignInForm
            submitLabel={tr('auth.owner.submit')}
            onSubmit={(request) => auth.signInOwner(request)}
          />
        )}
      </div>
    </main>
  );
}

function NameDevice({ signedInName }: { signedInName: string }) {
  const auth = useAuthStore();
  const tr = useT();
  const viewport = useViewport();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>(() => suggestedKind(viewport));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || trimmed === '') return;
    setBusy(true);
    setError(null);
    const result = await auth.registerDevice({ name: trimmed, kind });
    // A swallowed duplicate leaves the busy state to the attempt that is still running.
    if (!result.ok && result.duplicate) return;
    setBusy(false);
    if (!result.ok && result.error) setError(errorText(tr, result.error));
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="muted">{tr('auth.register.signedInAs', { name: signedInName })}</p>
      <TextField
        label={tr('auth.register.nameLabel')}
        value={name}
        maxLength={60}
        placeholder={tr('auth.register.namePlaceholder')}
        hint={tr('auth.register.nameHint')}
        disabled={busy}
        onChange={setName}
      />
      <div className="field-group">
        <span className="label" id="kind-label">
          {tr('auth.register.kindLabel')}
        </span>
        <div className="choices" role="radiogroup" aria-labelledby="kind-label">
          {KINDS.map((option) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented button group, not a native radio
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={kind === option ? 'choice choice--on' : 'choice'}
              disabled={busy}
              onClick={() => setKind(option)}
            >
              {tr(`device.kind.${option}`)}
            </button>
          ))}
        </div>
      </div>
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
        disabled={busy || trimmed === ''}
      >
        {tr('auth.register.submit')}
      </button>
      <button type="button" className="link" disabled={busy} onClick={() => void auth.signOut()}>
        {tr('auth.register.startOver')}
      </button>
    </form>
  );
}
