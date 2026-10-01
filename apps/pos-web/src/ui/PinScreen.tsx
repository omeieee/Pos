import { useState } from 'react';
import { errorText, waitText } from '../api/errors.ts';
import type { Principal } from '../auth/auth-store.ts';
import { lockSecondsLeft } from '../auth/pin-pad.ts';
import { Brand } from './Brand.tsx';
import { useAuthState, useAuthStore, useNow, useT } from './hooks.ts';
import { Icon } from './Icon.tsx';
import { Notice } from './Notice.tsx';
import { OwnerSignInScreen } from './OwnerSignInScreen.tsx';
import { PinPad } from './PinPad.tsx';

/** The registered device's lock screen: staff tiles, then the PIN pad. */
export function PinScreen() {
  const auth = useAuthStore();
  const state = useAuthState();
  const tr = useT();
  const [chosen, setChosen] = useState<Principal | null>(null);
  const [ownerMode, setOwnerMode] = useState(false);
  const anyLock = Object.values(state.pinLockedUntil).some((until) => until > Date.now());
  const now = useNow(anyLock ? 10_000 : null);

  if (ownerMode) return <OwnerSignInScreen onBack={() => setOwnerMode(false)} />;

  const { status, staff } = state.staffTiles;
  return (
    <main className="auth">
      <div className="card card--wide">
        <header className="card__head">
          <Brand />
          {state.device ? (
            <span className="chip">{tr('shell.device', { name: state.device.name })}</span>
          ) : null}
        </header>
        <Notice notice={state.notice} />
        {chosen ? (
          <PinEntry
            person={chosen}
            lockedFor={lockSecondsLeft(state.pinLockedUntil[chosen.id], now)}
            onBack={() => setChosen(null)}
          />
        ) : (
          <>
            <h1 className="card__title">{tr('auth.pin.title')}</h1>
            {status === 'loading' && staff.length === 0 ? (
              <p className="muted">{tr('common.loading')}</p>
            ) : null}
            {status === 'failed' ? (
              <div className="stack">
                <p className="error" role="alert">
                  {tr('auth.pin.loadFailed')} · {errorText(tr, state.staffTiles.error)}
                </p>
                <button type="button" className="btn" onClick={() => void auth.loadStaff()}>
                  {tr('common.retry')}
                </button>
              </div>
            ) : null}
            {status === 'ready' && staff.length === 0 ? (
              <div className="empty">
                <p className="strong">{tr('auth.pin.empty')}</p>
                <p className="muted">{tr('auth.pin.emptyHint')}</p>
              </div>
            ) : null}
            <ul className="tiles">
              {staff.map((person) => {
                const locked = lockSecondsLeft(state.pinLockedUntil[person.id], now) > 0;
                return (
                  <li key={person.id}>
                    <button type="button" className="tile" onClick={() => setChosen(person)}>
                      <span className="avatar">
                        <Icon name="user" />
                      </span>
                      <span className="tile__name">{person.displayName}</span>
                      <span className="tile__role">{tr(`role.${person.role}`)}</span>
                      {locked ? <span className="badge">{tr('auth.pin.lockedBadge')}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {chosen ? null : (
          <button type="button" className="link" onClick={() => setOwnerMode(true)}>
            {tr('auth.pin.ownerLink')}
          </button>
        )}
      </div>
    </main>
  );
}

function PinEntry({
  person,
  lockedFor,
  onBack,
}: {
  person: Principal;
  lockedFor: number;
  onBack: () => void;
}) {
  const auth = useAuthStore();
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    const result = await auth.signInWithPin(person.id, pin);
    setBusy(false);
    if (!result.ok && result.error) {
      setError(errorText(tr, result.error, 'pin'));
      setAttempt((n) => n + 1);
    }
  }

  return (
    <div className="stack">
      <button type="button" className="link link--back" onClick={onBack}>
        <Icon name="back" />
        {tr('auth.pin.changePerson')}
      </button>
      <h1 className="card__title">{tr('auth.pin.enterFor', { name: person.displayName })}</h1>
      <PinPad
        key={attempt}
        role={person.role}
        disabled={busy || lockedFor > 0}
        error={lockedFor > 0 ? tr('auth.pin.lockedFor', { wait: waitText(tr, lockedFor) }) : error}
        submitLabel={tr('auth.pin.submit')}
        onSubmit={(pin) => void submit(pin)}
      />
    </div>
  );
}
