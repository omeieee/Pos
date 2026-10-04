import type { StaffRole } from '@sds/shared';
import { type FormEvent, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import type { TextClipboard } from '../platform/clipboard.ts';
import { AuthCard, AuthFrame } from '../ui/AuthFrame.tsx';
import { useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { TextField } from '../ui/TextField.tsx';
import {
  emptyInviteDraft,
  type InviteDraft,
  type InviteFormField,
  inviteProblems,
  passwordStrength,
  pinHintDigits,
  sanitizeCode,
  sanitizePin,
} from './invite-model.ts';
import type { InviteStore } from './invite-store.ts';
import { QrSvg } from './QrSvg.tsx';

/**
 * The page an invite link opens (D-23): no session, no sign-in, only the two public calls of the
 * invite store. It shows who the invite is for, takes a name, a password, a PIN and the first
 * authenticator code, then shows the recovery codes once.
 */
export function InvitePage({ store, clipboard }: { store: InviteStore; clipboard: TextClipboard }) {
  const tr = useT();
  const state = useStoreState(store);
  const column = { display: 'flex', flexDirection: 'column', gap: 14 } as const;

  if (state.phase === 'loading') {
    return (
      <AuthFrame compactHero>
        <AuthCard>
          <p className="g-t-s" style={{ margin: 0, textAlign: 'center' }} role="status">
            {tr('invite.loading')}
          </p>
        </AuthCard>
      </AuthFrame>
    );
  }

  if (state.phase === 'invalid') {
    return (
      <AuthFrame compactHero>
        <AuthCard>
          <div style={column}>
            <h1 className="g-t-3" style={s('margin:0')}>
              {tr('invite.invalidTitle')}
            </h1>
            <Callout tone="bad" role="alert">
              {tr('error.inviteInvalid')}
            </Callout>
            <p className="g-t-s" style={s('margin:0')}>
              {tr('invite.invalidHelp')}
            </p>
          </div>
        </AuthCard>
      </AuthFrame>
    );
  }

  if (state.phase === 'unavailable') {
    return (
      <AuthFrame compactHero>
        <AuthCard>
          <div style={column}>
            <Callout tone="bad" role="alert">
              {errorText(tr, state.error)}
            </Callout>
            <button type="button" className="g-btn g-btn-lg g-btn-block" onClick={store.retry}>
              {tr('common.retry')}
            </button>
          </div>
        </AuthCard>
      </AuthFrame>
    );
  }

  if (state.phase === 'done') {
    return <RecoveryCodes codes={state.recoveryCodes} clipboard={clipboard} />;
  }

  // 'ready' and 'submitting': the form (the preview is kept while the answer is on its way).
  if (!state.preview) return null;
  return (
    <InviteForm
      store={store}
      preview={state.preview}
      submitting={state.phase === 'submitting'}
      failure={state.error}
    />
  );
}

function InviteForm({
  store,
  preview,
  submitting,
  failure,
}: {
  store: InviteStore;
  preview: NonNullable<ReturnType<InviteStore['getState']>['preview']>;
  submitting: boolean;
  failure: ReturnType<InviteStore['getState']>['error'];
}) {
  const tr = useT();
  const [draft, setDraft] = useState<InviteDraft>({
    ...emptyInviteDraft,
    displayName: preview.displayName ?? '',
  });
  const [tried, setTried] = useState(false);
  const [shown, setShown] = useState(false);
  const role: StaffRole = preview.role;
  const problems: InviteFormField[] = tried ? inviteProblems(role, draft) : [];
  const wrongCode = failure?.code === 'INVITE_CODE_INVALID';
  const set = (patch: Partial<InviteDraft>) => setDraft({ ...draft, ...patch });
  const strength = passwordStrength(draft.password);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (submitting || inviteProblems(role, draft).length > 0) return;
    const ok = await store.accept(draft);
    // A wrong code asks for the next one; everything else typed stays.
    if (!ok && store.getState().error?.code === 'INVITE_CODE_INVALID') {
      setDraft((current) => ({ ...current, code: '' }));
    }
  }

  return (
    <AuthFrame compactHero>
      <AuthCard>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          style={s('display:flex;flex-direction:column;gap:14px')}
        >
          <div>
            <h1 className="g-t-3" style={s('margin:0')}>
              {tr('invite.title')}
            </h1>
            <p className="g-t-s" style={s('margin:6px 0 0')}>
              {tr('invite.subtitle')}
            </p>
          </div>
          <Callout tone="info" role="note" icon="shieldCheck">
            {tr('invite.youAre', { role: tr(`role.${role}`) })}
          </Callout>
          <TextField
            icon="user"
            label={tr('invite.email')}
            type="email"
            autoComplete="username"
            value={preview.email}
            readOnly
            onChange={() => undefined}
          />
          <TextField
            icon="user"
            label={tr('invite.name')}
            autoComplete="name"
            maxLength={60}
            value={draft.displayName}
            disabled={submitting}
            error={problems.includes('displayName') ? tr('invite.error.displayName') : undefined}
            onChange={(displayName) => set({ displayName })}
          />
          <TextField
            icon="lock"
            label={tr('invite.password')}
            type={shown ? 'text' : 'password'}
            autoComplete="new-password"
            value={draft.password}
            disabled={submitting}
            hint={tr('invite.passwordHint')}
            error={problems.includes('password') ? tr('invite.error.password') : undefined}
            onChange={(password) => set({ password })}
            end={
              <button
                type="button"
                className="gfield__end"
                aria-label={shown ? tr('auth.owner.hidePassword') : tr('auth.owner.showPassword')}
                aria-pressed={shown}
                disabled={submitting}
                onClick={() => setShown((value) => !value)}
              >
                <Gi n={shown ? 'eyeOff' : 'eye'} />
              </button>
            }
          />
          {draft.password === '' ? null : (
            <p className="gfield__msg" role="status" data-strength={strength}>
              {tr(`invite.strength.${strength}`)}
            </p>
          )}
          <TextField
            icon="lock"
            label={tr('invite.pin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={draft.pin}
            disabled={submitting}
            hint={tr(`invite.pinHint.${pinHintDigits(role)}`)}
            error={problems.includes('pin') ? tr('invite.error.pin') : undefined}
            onChange={(pin) => set({ pin: sanitizePin(pin) })}
          />
          <TextField
            icon="lock"
            label={tr('invite.pin2')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={draft.pin2}
            disabled={submitting}
            error={problems.includes('pin2') ? tr('invite.error.pin2') : undefined}
            onChange={(pin2) => set({ pin2: sanitizePin(pin2) })}
          />
          <section style={s('display:flex;flex-direction:column;gap:10px')}>
            <h2 className="g-t-3" style={s('margin:0')}>
              {tr('invite.totp.title')}
            </h2>
            <p className="g-t-s" style={s('margin:0')}>
              {tr('invite.totp.body')}
            </p>
            <QrSvg text={preview.totp.otpauthUri} label={tr('invite.totp.qrLabel')} />
            <p className="g-t-c" style={s('margin:0')}>
              {tr('invite.totp.secret')}
            </p>
            <code
              data-testid="totp-secret"
              className="g-t-b"
              style={s(
                'display:block;overflow-wrap:anywhere;user-select:all;letter-spacing:.08em;font-variant-numeric:tabular-nums',
              )}
            >
              {preview.totp.secretBase32}
            </code>
            <p className="g-t-c" style={s('margin:0')}>
              {tr('invite.totp.reopen')}
            </p>
          </section>
          <TextField
            icon="shieldCheck"
            label={tr('invite.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={draft.code}
            disabled={submitting}
            error={
              wrongCode
                ? tr('error.inviteCodeInvalid')
                : problems.includes('code')
                  ? tr('invite.error.code')
                  : undefined
            }
            onChange={(code) => set({ code: sanitizeCode(code) })}
          />
          {failure && !wrongCode ? (
            <Callout tone="bad" role="alert">
              {errorText(tr, failure)}
            </Callout>
          ) : null}
          <button
            type="submit"
            className="g-btn g-btn-p g-btn-lg g-btn-block"
            disabled={submitting}
          >
            {submitting ? tr('invite.submitting') : tr('invite.submit')}
          </button>
        </form>
      </AuthCard>
    </AuthFrame>
  );
}

/**
 * The recovery codes, shown once. The person ticks that they saved them before the way on to
 * sign-in opens; the codes are in this page's memory only and are gone on leaving it.
 */
function RecoveryCodes({
  codes,
  clipboard,
}: {
  codes: readonly string[];
  clipboard: TextClipboard;
}) {
  const tr = useT();
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <AuthFrame compactHero>
      <AuthCard>
        <div style={s('display:flex;flex-direction:column;gap:14px')}>
          <h1 className="g-t-3" style={s('margin:0')}>
            {tr('invite.done.title')}
          </h1>
          <h2 className="g-t-3" style={s('margin:0')}>
            {tr('invite.done.codesTitle')}
          </h2>
          <p className="g-t-s" style={s('margin:0')}>
            {tr('invite.done.codesBody')}
          </p>
          <ul
            aria-label={tr('invite.done.codesTitle')}
            style={s(
              'list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px',
            )}
          >
            {codes.map((code) => (
              <li key={code}>
                <code className="g-t-b" style={s('user-select:all;letter-spacing:.06em')}>
                  {code}
                </code>
              </li>
            ))}
          </ul>
          <p className="g-t-c" style={s('margin:0')}>
            {tr('invite.done.codesHint')}
          </p>
          <button
            type="button"
            className="g-btn g-btn-lg g-btn-block"
            onClick={() => {
              // Straight from the tap: iOS Safari refuses a copy that waited on anything else.
              void clipboard
                .copyText(codes.join('\n'))
                .then((ok) => setCopy(ok ? 'copied' : 'failed'));
            }}
          >
            {tr('invite.done.copy')}
          </button>
          {copy === 'copied' ? (
            <Callout tone="ok" role="status">
              {tr('invite.done.copied')}
            </Callout>
          ) : null}
          {copy === 'failed' ? (
            <Callout tone="warn" role="status">
              {tr('invite.done.copyFailed')}
            </Callout>
          ) : null}
          <label style={s('display:flex;gap:10px;align-items:center;min-height:44px')}>
            <input
              type="checkbox"
              checked={saved}
              style={s('width:24px;height:24px;flex:none')}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <span className="g-t-b">{tr('invite.done.saved')}</span>
          </label>
          <Callout tone="info" role="note">
            {tr('invite.done.firstSignIn')}
          </Callout>
          {saved ? (
            <a className="g-btn g-btn-p g-btn-lg g-btn-block" href="/">
              {tr('invite.done.signIn')}
            </a>
          ) : (
            <button type="button" className="g-btn g-btn-p g-btn-lg g-btn-block" disabled>
              {tr('invite.done.signIn')}
            </button>
          )}
        </div>
      </AuthCard>
    </AuthFrame>
  );
}
