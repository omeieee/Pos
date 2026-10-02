import type { StaffDto } from '@sds/shared';
import { type ReactNode, useState } from 'react';
import { useActivityHold, useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { TextField } from '../ui/TextField.tsx';
import type { AdminOutcome } from './admin-store.ts';
import { adminFailureText } from './admin-text.ts';
import {
  buildNewStaff,
  CREATABLE_ROLES,
  type CreatableRole,
  type NewStaffField,
  pinProblems,
  validateNewStaff,
} from './staff-model.ts';

/** The frame of a staff dialog: title, fields, the failure of the last try, cancel and save. */
function Frame({
  title,
  saving,
  error,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const tr = useT();
  useActivityHold(true);
  return (
    <Modal labelledBy="staff-title" onClose={onClose} variant="options">
      <form
        className="mdialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className="osheet__head">
          <h2 id="staff-title" className="sheet__title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-soft"
            aria-label={tr('common.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="osheet__body">{children}</div>
        <footer className="osheet__foot">
          <div className="error-slot" role="alert">
            {error ? <p className="error">{error}</p> : null}
          </div>
          <div className="osheet__actions">
            <button type="button" className="btn btn-soft btn-lg" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-lg osheet__confirm"
              disabled={saving}
            >
              {saving ? tr('settings.staff.working') : tr('common.save')}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

/** Runs one store call for a dialog: the failure stays inside the dialog, a success closes it. */
function useDialogRun(onDone: (outcome: AdminOutcome<StaffDto>) => void) {
  const tr = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: Promise<AdminOutcome<StaffDto>>) {
    setSaving(true);
    setError(null);
    const outcome = await call;
    setSaving(false);
    if (outcome.ok) onDone(outcome);
    else setError(adminFailureText(tr, outcome));
  }
  return { saving, error, run };
}

/** A new person: a name, a role (never the owner) and a PIN typed twice. */
export function AddStaffDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { adminEditor } = useServices();
  const tr = useT();
  const [form, setForm] = useState({
    displayName: '',
    role: 'cashier' as CreatableRole,
    pin: '',
    pin2: '',
  });
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useDialogRun(() => {
    onAdded();
    onClose();
  });
  const problems: NewStaffField[] = tried ? validateNewStaff(form) : [];
  const fieldError = (field: NewStaffField) =>
    problems.includes(field) ? tr(`settings.staff.error.${field}`) : undefined;

  async function submit() {
    setTried(true);
    const input = buildNewStaff(form);
    if (input) await run(adminEditor.createStaff(input));
  }

  return (
    <Frame
      title={tr('settings.staff.addTitle')}
      saving={saving}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={tr('settings.staff.name')}
        value={form.displayName}
        maxLength={60}
        error={fieldError('displayName')}
        onChange={(displayName) => setForm({ ...form, displayName })}
      />
      <fieldset className="seg">
        <legend className="visually-hidden">{tr('settings.staff.role')}</legend>
        {CREATABLE_ROLES.map((role) => (
          <label key={role} className={`seg__item${form.role === role ? ' seg__item--on' : ''}`}>
            <input
              className="visually-hidden"
              type="radio"
              name="staff-role"
              checked={form.role === role}
              onChange={() => setForm({ ...form, role })}
            />
            {tr(`role.${role}`)}
          </label>
        ))}
      </fieldset>
      <TextField
        label={tr('settings.staff.pin')}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        hint={tr('settings.staff.pinHint')}
        error={fieldError('pin')}
        value={form.pin}
        onChange={(pin) => setForm({ ...form, pin })}
      />
      <TextField
        label={tr('settings.staff.pin2')}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={fieldError('pin2')}
        value={form.pin2}
        onChange={(pin2) => setForm({ ...form, pin2 })}
      />
      <p className="hint">{tr('settings.staff.pinNote')}</p>
    </Frame>
  );
}

/** The display name of one person (the role and the PIN are not changed here). */
export function RenameStaffDialog({ person, onClose }: { person: StaffDto; onClose: () => void }) {
  const { adminEditor } = useServices();
  const tr = useT();
  const [name, setName] = useState(person.displayName);
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useDialogRun(onClose);
  const trimmed = name.trim();
  const invalid = trimmed === '' || trimmed.length > 60;

  async function submit() {
    setTried(true);
    if (invalid) return;
    if (trimmed === person.displayName) return onClose();
    await run(adminEditor.patchStaff(person, { displayName: trimmed }));
  }

  return (
    <Frame
      title={tr('settings.staff.renameTitle')}
      saving={saving}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={tr('settings.staff.name')}
        value={name}
        maxLength={60}
        error={tried && invalid ? tr('settings.staff.error.displayName') : undefined}
        onChange={setName}
      />
    </Frame>
  );
}

/** A new PIN for one person: it follows that person's role and is typed twice. */
export function SetPinDialog({ person, onClose }: { person: StaffDto; onClose: () => void }) {
  const { adminEditor } = useServices();
  const tr = useT();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useDialogRun(onClose);
  const problems = tried ? pinProblems(person.role, pin, pin2) : [];

  async function submit() {
    setTried(true);
    if (pinProblems(person.role, pin, pin2).length > 0) return;
    await run(adminEditor.setStaffPin(person.id, pin));
  }

  return (
    <Frame
      title={tr('settings.staff.pinTitle')}
      saving={saving}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p>{tr('settings.staff.pinBody', { name: person.displayName })}</p>
      <TextField
        label={tr('settings.staff.pin')}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        hint={tr('settings.staff.pinHint')}
        error={problems.includes('pin') ? tr('settings.staff.error.pin') : undefined}
        value={pin}
        onChange={setPin}
      />
      <TextField
        label={tr('settings.staff.pin2')}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={problems.includes('pin2') ? tr('settings.staff.error.pin2') : undefined}
        value={pin2}
        onChange={setPin2}
      />
    </Frame>
  );
}
