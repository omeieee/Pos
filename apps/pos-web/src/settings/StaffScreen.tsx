import type { StaffDto } from '@sds/shared';
import { useEffect, useState } from 'react';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { AdminFrame, type AdminMessage } from './AdminFrame.tsx';
import { ADD_STAFF_KEY, staffKey } from './admin-store.ts';
import { adminFailureText } from './admin-text.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { AddStaffDialog, RenameStaffDialog, SetPinDialog } from './StaffDialogs.tsx';
import { staffDisplayState } from './staff-model.ts';

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
        <div className="sset__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={offline || state.pending.includes(ADD_STAFF_KEY)}
            onClick={() => {
              setMessage(null);
              setDialog({ kind: 'add' });
            }}
          >
            <Icon name="plus" />
            {tr('settings.staff.add')}
          </button>
        </div>
        {state.staff.items.length === 0 ? (
          <p className="muted">{tr('settings.staff.empty')}</p>
        ) : (
          <ul className="sset__list">
            {state.staff.items.map((person) => {
              const shown = staffDisplayState(person, nowMs);
              const busy = offline || state.pending.includes(staffKey(person.id));
              return (
                <li
                  key={person.id}
                  className={`sset__row${person.active ? '' : ' sset__row--off'}`}
                >
                  <div className="sset__row-main">
                    <span className="sset__row-name">{person.displayName}</span>
                    <span className="sset__row-meta">
                      <span className="tag">{tr(`role.${person.role}`)}</span>
                      {person.active ? null : (
                        <span className="tag">{tr('settings.staff.inactive')}</span>
                      )}
                      {shown.locked ? (
                        <span className="tag">{tr('settings.staff.locked')}</span>
                      ) : null}
                      {shown.noPin ? (
                        <span className="tag">{tr('settings.staff.noPin')}</span>
                      ) : null}
                    </span>
                    {shown.canEdit ? null : (
                      <span className="hint">{tr('settings.staff.ownerNote')}</span>
                    )}
                  </div>
                  {shown.canEdit ? (
                    <span className="sset__row-actions">
                      <button
                        type="button"
                        className="btn btn-soft"
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
                        className="btn btn-soft"
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
                          className="btn btn-soft"
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
                          className="btn btn-soft"
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
