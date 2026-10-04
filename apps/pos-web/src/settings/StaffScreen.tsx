import type { StaffDto } from '@sds/shared';
import { useEffect, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { AdminFrame, type AdminMessage } from './AdminFrame.tsx';
import { ADD_STAFF_KEY, staffKey } from './admin-store.ts';
import { adminFailureText } from './admin-text.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { AddStaffDialog, RenameStaffDialog, SetPinDialog } from './StaffDialogs.tsx';
import { staffDisplayState } from './staff-model.ts';
import './settings-glass.css';

const initial = (name: string) => Array.from(name.trim())[0] ?? '';

type Dialog =
  | { kind: 'add' }
  | { kind: 'rename'; person: StaffDto }
  | { kind: 'pin'; person: StaffDto }
  | { kind: 'deactivate'; person: StaffDto };

/**
 * The staff list (owner only; every call needs a fresh step-up): add a person with a PIN, rename,
 * set a new PIN, deactivate and reactivate. The owner is created once from the command line and has
 * no actions here. Switching someone off asks first; the rest are one step.
 */
export function StaffScreen() {
  const { adminEditor, outbox } = useServices();
  const state = useStoreState(adminEditor);
  const offline = useStoreState(outbox).offline;
  const tr = useT();
  const [message, setMessage] = useState<AdminMessage | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!offline) void adminEditor.loadStaff();
  }, [adminEditor, offline]);

  const nowMs = Date.now();

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
        onLoad={() => void adminEditor.loadStaff()}
      >
        <div className="gsave" style={s('justify-content:flex-start')}>
          <button
            type="button"
            className="g-btn g-btn-p"
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
              const shown = staffDisplayState(person, nowMs);
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
                    <span className="gset-meta">
                      <span className="g-badge g-b-mute">{tr(`role.${person.role}`)}</span>
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
                    {shown.canEdit ? null : (
                      <span className="g-t-c">{tr('settings.staff.ownerNote')}</span>
                    )}
                  </div>
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
      </AdminFrame>

      {dialog?.kind === 'add' ? (
        <AddStaffDialog
          onClose={() => setDialog(null)}
          onAdded={() => setMessage({ kind: 'ok', text: tr('settings.staff.added') })}
          onUncertain={(text) => setMessage({ kind: 'error', text })}
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
