import { formatDate, type Locale } from '@sds/i18n';
import type { InviteDto, StaffDto } from '@sds/shared';
import { useEffect, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useAuthState, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { AdminFrame, type AdminMessage } from './AdminFrame.tsx';
import {
  ADD_INVITE_KEY,
  ADD_STAFF_KEY,
  type AdminState,
  inviteKey,
  staffKey,
} from './admin-store.ts';
import { adminFailureText } from './admin-text.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { AddStaffDialog, RenameStaffDialog, SetPinDialog } from './StaffDialogs.tsx';
import { ChangeRoleDialog, InviteDialog } from './StaffInviteDialogs.tsx';
import { staffDisplayState } from './staff-model.ts';
import './settings-glass.css';

const initial = (name: string) => Array.from(name.trim())[0] ?? '';

type Dialog =
  | { kind: 'add' }
  | { kind: 'invite' }
  | { kind: 'role'; person: StaffDto }
  | { kind: 'revokeInvite'; invite: InviteDto }
  | { kind: 'rename'; person: StaffDto }
  | { kind: 'pin'; person: StaffDto }
  | { kind: 'deactivate'; person: StaffDto };

/**
 * The staff list (owner only; every call needs a fresh step-up): invite a person by e-mail, add a
 * person with a PIN, rename, set a new PIN, change the role, deactivate and reactivate, and the open
 * invites with their expiry. Nobody changes their own account: the signed-in person's row only says
 * so. Switching someone off, or cancelling an invite, asks first; the rest are one step.
 */
export function StaffScreen() {
  const { adminEditor, outbox } = useServices();
  const state = useStoreState(adminEditor);
  const offline = useStoreState(outbox).offline;
  const tr = useT();
  const locale = useLocale();
  const selfId = useAuthState().session?.staff.id ?? null;
  const [message, setMessage] = useState<AdminMessage | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!offline) void adminEditor.loadStaffScreen();
  }, [adminEditor, offline]);

  const nowMs = Date.now();

  async function revoke(invite: InviteDto) {
    setMessage(null);
    setDialogError(null);
    const outcome = await adminEditor.revokeInvite(invite.id);
    if (outcome.ok) {
      setDialog(null);
      setMessage({ kind: 'ok', text: tr('settings.staff.invites.revoked') });
      return;
    }
    const text = adminFailureText(tr, outcome);
    if (!text) return;
    if (outcome.reason === 'error' && outcome.refreshed) {
      setDialog(null);
      setMessage({ kind: 'error', text });
    } else setDialogError(text);
  }

  async function run(person: StaffDto, change: { active: boolean }, closeDialog: boolean) {
    setMessage(null);
    setDialogError(null);
    const outcome = await adminEditor.patchStaff(person, change);
    if (outcome.ok) {
      if (closeDialog) setDialog(null);
      setMessage({ kind: 'ok', text: tr('settings.saved') });
      return;
    }
    const text = adminFailureText(tr, outcome);
    if (!text) return;
    // A confirm dialog shows its own failure; a one-step action shows it on the page.
    if (closeDialog && !(outcome.reason === 'error' && outcome.refreshed)) setDialogError(text);
    else {
      setDialog(null);
      setMessage({ kind: 'error', text });
    }
  }

  return (
    <>
      <AdminFrame
        slot={state.staff}
        offline={offline}
        message={message}
        onLoad={() => void adminEditor.loadStaffScreen()}
      >
        <div className="gsave" style={s('justify-content:flex-start;flex-wrap:wrap;gap:8px')}>
          <button
            type="button"
            className="g-btn g-btn-p"
            disabled={offline || state.pending.includes(ADD_INVITE_KEY)}
            onClick={() => {
              setMessage(null);
              setDialog({ kind: 'invite' });
            }}
          >
            <Gi n="plus" size="sm" />
            {tr('settings.staff.invite')}
          </button>
          <button
            type="button"
            className="g-btn"
            disabled={offline || state.pending.includes(ADD_STAFF_KEY)}
            onClick={() => {
              setMessage(null);
              setDialog({ kind: 'add' });
            }}
          >
            <Gi n="plus" size="sm" />
            {tr('settings.staff.add')}
          </button>
        </div>
        {state.staff.items.length === 0 ? (
          <p className="g-t-s" style={s('margin:0')}>
            {tr('settings.staff.empty')}
          </p>
        ) : (
          <ul className="g-glass gset-grp gset-list">
            {state.staff.items.map((person) => {
              const shown = staffDisplayState(person, nowMs, selfId);
              const busy = offline || state.pending.includes(staffKey(person.id));
              return (
                <li
                  key={person.id}
                  className={`g-row gset-rowbox${person.active ? '' : ' gset-rowbox--off'}`}
                >
                  <span className="g-avatar" aria-hidden="true">
                    {initial(person.displayName)}
                  </span>
                  <div className="gset-main">
                    <span className="g-t-3" style={s('overflow-wrap:anywhere')}>
                      {person.displayName}
                    </span>
                    <span className="g-t-c" style={s('overflow-wrap:anywhere')}>
                      {person.email ?? tr('settings.staff.noEmail')}
                    </span>
                    <span className="gset-meta">
                      <span className="g-badge g-b-mute">{tr(`role.${person.role}`)}</span>
                      {shown.isSelf ? (
                        <span className="g-badge g-b-ok">{tr('settings.staff.you')}</span>
                      ) : null}
                      {person.active ? null : (
                        <span className="g-badge g-b-bad">
                          <Gi n="x" />
                          {tr('settings.staff.inactive')}
                        </span>
                      )}
                      {shown.locked ? (
                        <span className="g-badge g-b-warn">
                          <Gi n="lock" />
                          {tr('settings.staff.locked')}
                        </span>
                      ) : null}
                      {shown.noPin ? (
                        <span className="g-badge g-b-warn">
                          <Gi n="warn" />
                          {tr('settings.staff.noPin')}
                        </span>
                      ) : null}
                    </span>
                    {shown.isSelf ? (
                      <span className="g-t-c" id={`self-note-${person.id}`}>
                        {tr('settings.staff.selfNote')}
                      </span>
                    ) : null}
                  </div>
                  {shown.isSelf ? (
                    <span className="gset-actions">
                      <button
                        type="button"
                        className="g-btn gbtn-row"
                        disabled
                        aria-describedby={`self-note-${person.id}`}
                        title={tr('settings.staff.changeRoleSelf')}
                      >
                        {tr('settings.staff.changeRole')}
                      </button>
                    </span>
                  ) : null}
                  {shown.canEdit ? (
                    <span className="gset-actions">
                      <button
                        type="button"
                        className="g-btn gbtn-row"
                        aria-label={tr('settings.staff.rename', { name: person.displayName })}
                        disabled={busy}
                        onClick={() => {
                          setMessage(null);
                          setDialog({ kind: 'rename', person });
                        }}
                      >
                        {tr('settings.staff.renameTitle')}
                      </button>
                      <button
                        type="button"
                        className="g-btn gbtn-row"
                        aria-label={tr('settings.staff.setPin', { name: person.displayName })}
                        disabled={busy}
                        onClick={() => {
                          setMessage(null);
                          setDialog({ kind: 'pin', person });
                        }}
                      >
                        {tr('settings.staff.pinTitle')}
                      </button>
                      <button
                        type="button"
                        className="g-btn gbtn-row"
                        aria-label={tr('settings.staff.changeRoleLabel', {
                          name: person.displayName,
                        })}
                        disabled={busy}
                        onClick={() => {
                          setMessage(null);
                          setDialog({ kind: 'role', person });
                        }}
                      >
                        {tr('settings.staff.changeRole')}
                      </button>
                      {shown.canDeactivate ? (
                        <button
                          type="button"
                          className="g-btn gbtn-row"
                          aria-label={tr('settings.staff.deactivate', { name: person.displayName })}
                          disabled={busy}
                          onClick={() => {
                            setMessage(null);
                            setDialogError(null);
                            setDialog({ kind: 'deactivate', person });
                          }}
                        >
                          {tr('settings.staff.deactivateConfirm')}
                        </button>
                      ) : null}
                      {shown.canActivate ? (
                        <button
                          type="button"
                          className="g-btn gbtn-row"
                          aria-label={tr('settings.staff.activate', { name: person.displayName })}
                          disabled={busy}
                          onClick={() => void run(person, { active: true }, false)}
                        >
                          {tr('settings.staff.activateLabel')}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <InvitesList
          invites={state.invites}
          offline={offline}
          pending={state.pending}
          locale={locale}
          onRetry={() => void adminEditor.loadInvites()}
          onRevoke={(invite) => {
            setMessage(null);
            setDialogError(null);
            setDialog({ kind: 'revokeInvite', invite });
          }}
        />
      </AdminFrame>

      {dialog?.kind === 'add' ? (
        <AddStaffDialog
          onClose={() => setDialog(null)}
          onAdded={() => setMessage({ kind: 'ok', text: tr('settings.staff.added') })}
          onUncertain={(text) => setMessage({ kind: 'error', text })}
        />
      ) : null}
      {dialog?.kind === 'invite' ? (
        <InviteDialog
          onClose={() => setDialog(null)}
          onCreated={() => setMessage(null)}
          onUncertain={(text) => setMessage({ kind: 'error', text })}
        />
      ) : null}
      {dialog?.kind === 'role' ? (
        <ChangeRoleDialog
          person={dialog.person}
          onClose={() => setDialog(null)}
          onChanged={() => setMessage({ kind: 'ok', text: tr('settings.staff.changeRoleDone') })}
        />
      ) : null}
      {dialog?.kind === 'revokeInvite' ? (
        <ConfirmDialog
          title={tr('settings.staff.invites.revokeTitle', { email: dialog.invite.email })}
          body={tr('settings.staff.invites.revokeBody')}
          confirmLabel={tr('settings.staff.invites.revoke')}
          busy={state.pending.includes(inviteKey(dialog.invite.id))}
          error={dialogError}
          onConfirm={() => void revoke(dialog.invite)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <RenameStaffDialog person={dialog.person} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'pin' ? (
        <SetPinDialog person={dialog.person} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'deactivate' ? (
        <ConfirmDialog
          title={tr('settings.staff.deactivateTitle', { name: dialog.person.displayName })}
          body={tr('settings.staff.deactivateBody')}
          confirmLabel={tr('settings.staff.deactivateConfirm')}
          busy={state.pending.includes(staffKey(dialog.person.id))}
          error={dialogError}
          onConfirm={() => void run(dialog.person, { active: false }, true)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

/** The invites still open (or expired and not cleared), each with its expiry and a Cancel button. */
function InvitesList({
  invites,
  offline,
  pending,
  locale,
  onRetry,
  onRevoke,
}: {
  invites: AdminState['invites'];
  offline: boolean;
  pending: readonly string[];
  locale: Locale;
  onRetry: () => void;
  onRevoke: (invite: InviteDto) => void;
}) {
  const tr = useT();
  return (
    <section style={s('display:flex;flex-direction:column;gap:10px')} aria-labelledby="invites-h">
      <h2 id="invites-h" className="g-t-3" style={s('margin:0')}>
        {tr('settings.staff.invites.title')}
      </h2>
      {invites.status === 'error' ? (
        <Callout
          tone="bad"
          role="alert"
          action={
            <button type="button" className="g-btn gbtn-row" disabled={offline} onClick={onRetry}>
              {tr('common.retry')}
            </button>
          }
        >
          {tr('settings.admin.loadFailed')}
        </Callout>
      ) : null}
      {invites.status === 'ready' && invites.items.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.staff.invites.none')}
        </p>
      ) : null}
      {invites.items.length > 0 ? (
        <ul className="g-glass gset-grp gset-list">
          {invites.items.map((invite) => {
            const when = formatDate(invite.expiresAt, locale, 'dateTime');
            const expired = invite.status === 'expired';
            return (
              <li
                key={invite.id}
                className={`g-row gset-rowbox${expired ? ' gset-rowbox--off' : ''}`}
              >
                <div className="gset-main">
                  <span className="g-t-3" style={s('overflow-wrap:anywhere')}>
                    {invite.email}
                  </span>
                  <span className="gset-meta">
                    <span className="g-badge g-b-mute">{tr(`role.${invite.role}`)}</span>
                    {expired ? (
                      <span className="g-badge g-b-warn">
                        <Gi n="clock" />
                        {tr('settings.staff.invites.expiredBadge')}
                      </span>
                    ) : null}
                  </span>
                  <span className="g-t-c">
                    {tr(
                      expired ? 'settings.staff.invites.expired' : 'settings.staff.invites.expires',
                      { when },
                    )}
                  </span>
                </div>
                <span className="gset-actions">
                  <button
                    type="button"
                    className="g-btn gbtn-row"
                    aria-label={tr('settings.staff.invites.revokeLabel', { email: invite.email })}
                    disabled={offline || pending.includes(inviteKey(invite.id))}
                    onClick={() => onRevoke(invite)}
                  >
                    {tr('settings.staff.invites.revoke')}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
