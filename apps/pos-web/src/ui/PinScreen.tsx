import { useState } from 'react';
import { errorText, waitText } from '../api/errors.ts';
import type { Principal } from '../auth/auth-store.ts';
import { hasActiveLock, lockSecondsLeft } from '../auth/pin-pad.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { AuthCard, AuthFrame } from './AuthFrame.tsx';
import { useAuthState, useAuthStore, useConnection, useNow, useT } from './hooks.ts';
import { Callout, Notice } from './Notice.tsx';
import { OwnerSignInScreen } from './OwnerSignInScreen.tsx';
import { PinPad } from './PinPad.tsx';
import './glass-forms.css';

const initial = (name: string) => Array.from(name.trim())[0] ?? '';

/** "or" between the staff list and the other ways in, as in the design. */
function OrDivider() {
  const tr = useT();
  return (
    <div style={s('display:flex;align-items:center;gap:12px')}>
      <hr className="g-hair" style={s('flex-grow:1')} />
      <span className="g-t-c">{tr('auth.divider.or')}</span>
      <hr className="g-hair" style={s('flex-grow:1')} />
    </div>
  );
}

/** The device line under the card: a pulsing dot when the connection is up, then the device name. */
function DeviceLine({ name }: { name: string }) {
  const tr = useT();
  const online = useConnection().status === 'online';
  return (
    <div className="gauth__foot g-t-c">
      {online ? <span className="g-dot" /> : <Gi n="monitor" size="sm" />}
      <span>
        {tr('shell.device', { name })}
        {online ? ` · ${tr('net.online')}` : ''}
      </span>
    </div>
  );
}

/** The registered device's lock screen: staff cards, then the PIN pad. */
export function PinScreen() {
  const auth = useAuthStore();
  const state = useAuthState();
  const tr = useT();
  const [chosen, setChosen] = useState<Principal | null>(null);
  const [ownerMode, setOwnerMode] = useState(false);
  // The time is read at render, and the screen re-renders each second only while a lock runs.
  const [ticking, setTicking] = useState(false);
  const now = useNow(ticking ? 1_000 : null);
  const anyLock = hasActiveLock(state.pinLockedUntil, now);
  if (anyLock !== ticking) setTicking(anyLock);

  if (ownerMode) return <OwnerSignInScreen onBack={() => setOwnerMode(false)} />;

  const { status, staff } = state.staffTiles;
  return (
    <AuthFrame
      compactHero={chosen !== null}
      footer={state.device ? <DeviceLine name={state.device.name} /> : null}
    >
      <AuthCard>
        <Notice notice={state.notice} />
        {chosen ? (
          <PinEntry
            person={chosen}
            lockedFor={lockSecondsLeft(state.pinLockedUntil[chosen.id], now)}
            onBack={() => setChosen(null)}
          />
        ) : (
          <>
            <h1 className="g-t-1" style={s('margin:0')}>
              {tr('auth.pin.title')}
            </h1>
            <div className="g-t-s" style={s('margin-top:-8px')}>
              {tr('auth.pin.subtitle')}
            </div>
            {status === 'loading' && staff.length === 0 ? (
              <p className="g-t-s" style={s('margin:0')} role="status">
                {tr('common.loading')}
              </p>
            ) : null}
            {status === 'failed' ? (
              <Callout
                tone="bad"
                role="alert"
                action={
                  <button
                    type="button"
                    className="g-btn g-btn-sm"
                    onClick={() => void auth.loadStaff()}
                  >
                    {tr('common.retry')}
                  </button>
                }
              >
                {tr('auth.pin.loadFailed')} · {errorText(tr, state.staffTiles.error)}
              </Callout>
            ) : null}
            {status === 'ready' && staff.length === 0 ? (
              <div className="g-sunk" style={s('padding:18px;text-align:center')}>
                <p className="g-t-3" style={s('margin:0')}>
                  {tr('auth.pin.empty')}
                </p>
                <p className="g-t-s" style={s('margin:4px 0 0')}>
                  {tr('auth.pin.emptyHint')}
                </p>
              </div>
            ) : null}
            {staff.length > 0 ? (
              <>
                <div className="g-t-c" style={s('padding-left:4px;margin-bottom:-6px')}>
                  {tr('auth.pin.pick')}
                </div>
                <ul className="gauth__list">
                  {staff.map((person) => {
                    const locked = lockSecondsLeft(state.pinLockedUntil[person.id], now) > 0;
                    return (
                      <li key={person.id}>
                        <button
                          type="button"
                          className="tile gauth__who"
                          onClick={() => setChosen(person)}
                        >
                          <span className="g-avatar" aria-hidden="true">
                            {initial(person.displayName)}
                          </span>
                          <span style={s('flex:1;min-width:0;display:flex;flex-direction:column')}>
                            <span className="g-t-3" style={s('overflow-wrap:anywhere')}>
                              {person.displayName}
                            </span>
                            <span className="g-t-c">{tr(`role.${person.role}`)}</span>
                          </span>
                          {locked ? (
                            <span className="g-badge g-b-warn">
                              <Gi n="lock" />
                              {tr('auth.pin.lockedBadge')}
                            </span>
                          ) : (
                            <Gi
                              n="chevronRight"
                              className="gauth__chev"
                              style={s('color:var(--ink3)')}
                            />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            <OrDivider />
            <div style={s('display:flex;flex-direction:column;gap:10px')}>
              <button
                type="button"
                className="g-btn g-btn-lg g-btn-block"
                disabled
                aria-disabled="true"
                title={tr('nav.notReady')}
              >
                <Gi n="shieldCheck" />
                {tr('auth.passkey')}
              </button>
              <button
                type="button"
                className="g-btn g-btn-lg g-btn-block"
                onClick={() => setOwnerMode(true)}
              >
                <Gi n="lock" />
                {tr('auth.pin.ownerLink')}
              </button>
            </div>
            <div className="g-t-c" style={s('text-align:center')}>
              {tr('auth.pin.forgot')}
            </div>
          </>
        )}
      </AuthCard>
    </AuthFrame>
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
    // A swallowed duplicate leaves the busy state to the attempt that is still running.
    if (!result.ok && result.duplicate) return;
    setBusy(false);
    if (!result.ok && result.error) {
      setError(errorText(tr, result.error, 'pin'));
      setAttempt((n) => n + 1);
    }
  }

  return (
    <>
      <button type="button" className="gauth__back" onClick={onBack}>
        <Gi n="chevronLeft" />
        {tr('auth.pin.changePerson')}
      </button>
      <div style={s('display:flex;align-items:center;gap:14px')}>
        <span className="g-avatar" style={s('width:52px;height:52px;font-size:20px')}>
          {initial(person.displayName)}
        </span>
        <div style={s('min-width:0')}>
          <h1 className="g-t-2" style={s('margin:0;overflow-wrap:anywhere')}>
            {tr('auth.pin.enterFor', { name: person.displayName })}
          </h1>
          <div className="g-t-c">{tr(`role.${person.role}`)}</div>
        </div>
      </div>
      <PinPad
        key={attempt}
        role={person.role}
        disabled={busy || lockedFor > 0}
        error={lockedFor > 0 ? tr('auth.pin.lockedFor', { wait: waitText(tr, lockedFor) }) : error}
        submitLabel={tr('auth.pin.submit')}
        onSubmit={(pin) => void submit(pin)}
      />
    </>
  );
}
