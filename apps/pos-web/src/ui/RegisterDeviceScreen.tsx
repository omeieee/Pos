import type { DeviceKind } from '@sds/shared';
import { type FormEvent, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { s } from '../design/style.ts';
import { suggestedKind } from '../theme/device.ts';
import { AuthCard, AuthFrame } from './AuthFrame.tsx';
import { useAuthState, useAuthStore, useT, useViewport } from './hooks.ts';
import { Callout, Notice } from './Notice.tsx';
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
    <AuthFrame compactHero>
      <AuthCard>
        <Notice notice={state.notice} />
        <h1 className="g-t-1" style={s('margin:0')}>
          {tr('auth.register.title')}
        </h1>
        <div className="g-t-s" style={s('margin-top:-8px')}>
          {tr('auth.register.intro')}
        </div>
        <div
          className="g-sunk"
          style={s('padding:10px 14px;display:flex;align-items:center;gap:10px')}
        >
          <span className="g-badge g-b-info" aria-hidden="true">
            {signedIn ? '2' : '1'}
          </span>
          <h2 className="g-t-3" style={s('margin:0')}>
            {signedIn ? tr('auth.register.step2') : tr('auth.register.step1')}
          </h2>
        </div>
        {state.session ? (
          <NameDevice signedInName={state.session.staff.displayName} />
        ) : (
          <OwnerSignInForm
            submitLabel={tr('auth.owner.submit')}
            onSubmit={(request) => auth.signInOwner(request)}
          />
        )}
      </AuthCard>
    </AuthFrame>
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
    <form onSubmit={submit} noValidate style={s('display:flex;flex-direction:column;gap:14px')}>
      <p className="g-t-s" style={s('margin:0')}>
        {tr('auth.register.signedInAs', { name: signedInName })}
      </p>
      <TextField
        icon="monitor"
        label={tr('auth.register.nameLabel')}
        value={name}
        maxLength={60}
        placeholder={tr('auth.register.namePlaceholder')}
        hint={tr('auth.register.nameHint')}
        disabled={busy}
        onChange={setName}
      />
      <div style={s('display:flex;flex-direction:column;gap:6px')}>
        <span className="gfield__label" id="kind-label">
          {tr('auth.register.kindLabel')}
        </span>
        <div
          className="g-seg"
          role="radiogroup"
          aria-labelledby="kind-label"
          style={s('display:flex;width:100%')}
        >
          {KINDS.map((option) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented button group, not a native radio
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={kind === option ? 'g-chip g-on' : 'g-chip'}
              style={s('flex:1 1 0;padding:0 8px')}
              disabled={busy}
              onClick={() => setKind(option)}
            >
              {tr(`device.kind.${option}`)}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <Callout tone="bad" role="alert">
          {error}
        </Callout>
      ) : null}
      <button
        type="submit"
        className="g-btn g-btn-p g-btn-lg g-btn-block"
        disabled={busy || trimmed === ''}
      >
        {tr('auth.register.submit')}
      </button>
      <button
        type="button"
        className="gauth__link"
        disabled={busy}
        onClick={() => void auth.signOut()}
      >
        {tr('auth.register.startOver')}
      </button>
    </form>
  );
}
