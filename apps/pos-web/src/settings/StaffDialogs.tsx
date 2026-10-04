import type { StaffDto } from '@sds/shared';
import { type ReactNode, useState } from 'react';
import { DialogLayout } from '../ui/DialogParts.tsx';
import { SegRadio } from '../ui/FormParts.tsx';
import { useActivityHold, useServices, useT } from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';
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
    <PortalModal labelledBy="staff-title" onClose={onClose}>
      <DialogLayout
        titleId="staff-title"
        title={title}
        onClose={onClose}
        onSubmit={onSubmit}
        error={error}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button type="submit" className="g-btn g-btn-p g-btn-lg" disabled={saving}>
              {saving ? tr('settings.staff.working') : tr('common.save')}
            </button>
          </>
        }
      >
        {children}
      </DialogLayout>
    </PortalModal>
  );
}

/**
 * Runs one store call for a dialog: the failure stays inside the dialog, a success closes it. With
 * `onUncertain`, a lost answer is handed to the caller instead (the dialog is closed there, so the
 * typed values cannot be sent again).
 */
function useDialogRun(
  onDone: (outcome: AdminOutcome<StaffDto>) => void,
  onUncertain?: (text: string) => void,
) {
  const tr = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: Promise<AdminOutcome<StaffDto>>) {
    setSaving(true);
    setError(null);
    const outcome = await call;
    setSaving(false);
    if (outcome.ok) onDone(outcome);
    else if (onUncertain && outcome.reason === 'error' && outcome.uncertain) {
      onUncertain(adminFailureText(tr, outcome) ?? '');
    } else setError(adminFailureText(tr, outcome));
  }
  return { saving, error, run };
}

/** A new person: a name, a role (never the owner) and a PIN typed twice. */
export function AddStaffDialog({
  onClose,
  onAdded,
  onUncertain,
}: {
  onClose: () => void;
  onAdded: () => void;
  /** The answer was lost: the caller closes this dialog and tells the person to look at the list. */
  onUncertain: (text: string) => void;
}) {
  const { adminEditor } = useServices();
  const tr = useT();
  const [form, setForm] = useState({
    displayName: '',
    role: 'cashier' as CreatableRole,
    pin: '',
    pin2: '',
  });
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useDialogRun(
    () => {
      onAdded();
      onClose();
    },
    (text) => {
      // Nothing typed here is kept: a second Save would add the person twice.
      setForm({ displayName: '', role: 'cashier', pin: '', pin2: '' });
      onUncertain(text);
      onClose();
    },
  );
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
        icon="user"
        label={tr('settings.staff.name')}
        value={form.displayName}
        maxLength={60}
        error={fieldError('displayName')}
        onChange={(displayName) => setForm({ ...form, displayName })}
      />
      <SegRadio
        legend={tr('settings.staff.role')}
        name="staff-role"
        value={form.role}
        options={CREATABLE_ROLES.map((role) => ({ value: role, label: tr(`role.${role}`) }))}
        onChange={(role) => setForm({ ...form, role })}
      />
      <TextField
        icon="lock"
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
        icon="lock"
        label={tr('settings.staff.pin2')}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        error={fieldError('pin2')}
        value={form.pin2}
        onChange={(pin2) => setForm({ ...form, pin2 })}
      />
      <p className="g-t-c" style={{ margin: 0 }}>
        {tr('settings.staff.pinNote')}
      </p>
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
        icon="user"
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
      <p className="g-t-b" style={{ margin: 0 }}>
        {tr('settings.staff.pinBody', { name: person.displayName })}
      </p>
      <TextField
        icon="lock"
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
        icon="lock"
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
