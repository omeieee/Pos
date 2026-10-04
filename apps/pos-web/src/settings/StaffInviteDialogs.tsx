import type { CreateInviteResponse, StaffDto, StaffRole } from '@sds/shared';
import { useId, useState } from 'react';
import { inviteLink } from '../platform/appLocation.ts';
import { DialogLayout } from '../ui/DialogParts.tsx';
import { useServices, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { PortalModal } from '../ui/PortalModal.tsx';
import { TextField } from '../ui/TextField.tsx';
import { Frame, useDialogRun } from './StaffDialogs.tsx';
import {
  buildInvite,
  canBecomeOwner,
  INVITE_ROLES,
  type InviteField,
  minPinDigits,
  roleChangeNeedsPin,
  roleChangePin,
  validateInvite,
  validateRoleChange,
} from './staff-model.ts';

/**
 * The role picker: one card per role with its plain explanation (a row of four Thai names does not
 * fit an iPhone). The radio is visually hidden but real, so it works with keyboard and VoiceOver.
 */
function RoleChoice({
  name,
  value,
  disabledRoles = [],
  onChange,
}: {
  name: string;
  value: StaffRole;
  disabledRoles?: readonly StaffRole[];
  onChange: (role: StaffRole) => void;
}) {
  const tr = useT();
  const id = useId();
  return (
    <>
      <fieldset className="gset-roles">
        <legend className="gvh">{tr('settings.staff.role')}</legend>
        {INVITE_ROLES.map((role) => {
          const off = disabledRoles.includes(role);
          return (
            <label key={role} className={`gset-role${off ? ' gset-role--off' : ''}`}>
              <input
                type="radio"
                name={name}
                checked={value === role}
                disabled={off}
                aria-labelledby={`${id}-${role}-name`}
                aria-describedby={`${id}-${role}-desc`}
                onChange={() => onChange(role)}
              />
              <span id={`${id}-${role}-name`} className="g-t-3">
                {tr(`role.${role}`)}
              </span>
              <span id={`${id}-${role}-desc`} className="g-t-c">
                {tr(`settings.staff.roleDesc.${role}`)}
              </span>
            </label>
          );
        })}
      </fieldset>
      {value === 'owner' ? (
        <Callout tone="warn" role="note">
          {tr('settings.staff.ownerWarn')}
        </Callout>
      ) : null}
    </>
  );
}

/**
 * Invite a person by e-mail (D-23). Step one asks for the e-mail and role; step two shows the link
 * ONCE (the token lives only in this dialog's memory), with a copy button and a field to select by
 * hand where copying is refused. The system sends no e-mail: the owner sends the link.
 */
export function InviteDialog({
  onClose,
  onCreated,
  onUncertain,
}: {
  onClose: () => void;
  /** An invite was made (the list already has it). */
  onCreated: () => void;
  /** The answer was lost: the caller closes this dialog and points at the invites list. */
  onUncertain: (text: string) => void;
}) {
  const { adminEditor, clipboard } = useServices();
  const tr = useT();
  const [form, setForm] = useState({ email: '', displayName: '', role: 'cashier' as StaffRole });
  const [tried, setTried] = useState(false);
  const [made, setMade] = useState<{ link: string; email: string } | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const { saving, error, run } = useDialogRun<CreateInviteResponse>(
    (outcome) => {
      setMade({ link: inviteLink(outcome.value.token), email: outcome.value.email });
      onCreated();
    },
    () => {
      // Nothing typed is kept: a second try would meet INVITE_EXISTS or make a second invite. The
      // token is lost with the answer, so the way on is to cancel the invite and make a new one.
      onUncertain(tr('settings.staff.inviteUncertain'));
      onClose();
    },
  );
  const problems: InviteField[] = tried ? validateInvite(form) : [];

  async function submit() {
    setTried(true);
    const input = buildInvite(form);
    if (input) await run(adminEditor.createInvite(input));
  }

  if (made) {
    return (
      <PortalModal labelledBy="staff-title" onClose={onClose}>
        <DialogLayout
          titleId="staff-title"
          title={tr('settings.staff.linkTitle')}
          onClose={onClose}
          actions={
            <button type="button" className="g-btn g-btn-p g-btn-lg" onClick={onClose}>
              {tr('settings.staff.linkDone')}
            </button>
          }
        >
          <p className="g-t-b" style={{ margin: 0 }}>
            {tr('settings.staff.linkBody', { email: made.email })}
          </p>
          <fieldset className="gfield" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="gfield__label">{tr('settings.staff.linkLabel')}</legend>
            <code data-testid="invite-link" className="gset-link">
              {made.link}
            </code>
          </fieldset>
          <button
            type="button"
            className="g-btn g-btn-lg g-btn-block"
            onClick={() => {
              // Straight from the tap: iOS Safari refuses a copy that waited on anything else.
              void clipboard.copyText(made.link).then((ok) => setCopy(ok ? 'copied' : 'failed'));
            }}
          >
            {tr('settings.staff.linkCopy')}
          </button>
          {copy === 'copied' ? (
            <Callout tone="ok" role="status">
              {tr('settings.staff.linkCopied')}
            </Callout>
          ) : null}
          {copy === 'failed' ? (
            <Callout tone="warn" role="status">
              {tr('settings.staff.linkCopyFailed')}
            </Callout>
          ) : null}
          <Callout tone="info" role="note">
            {tr('settings.staff.linkNote')}
          </Callout>
        </DialogLayout>
      </PortalModal>
    );
  }

  return (
    <Frame
      title={tr('settings.staff.inviteTitle')}
      submitLabel={tr('settings.staff.inviteCreate')}
      saving={saving}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p className="g-t-s" style={{ margin: 0 }}>
        {tr('settings.staff.inviteIntro')}
      </p>
      <TextField
        icon="user"
        label={tr('settings.staff.inviteEmail')}
        type="email"
        inputMode="email"
        autoComplete="off"
        value={form.email}
        error={problems.includes('email') ? tr('settings.staff.error.email') : undefined}
        onChange={(email) => setForm({ ...form, email })}
      />
      <TextField
        icon="user"
        label={tr('settings.staff.inviteName')}
        value={form.displayName}
        maxLength={60}
        hint={tr('settings.staff.inviteNameHint')}
        error={
          problems.includes('displayName') ? tr('settings.staff.error.displayName') : undefined
        }
        onChange={(displayName) => setForm({ ...form, displayName })}
      />
      <RoleChoice
        name="invite-role"
        value={form.role}
        onChange={(role) => setForm({ ...form, role })}
      />
    </Frame>
  );
}

/**
 * Moves one person to another role. A PIN field shows only when the new role needs one (a longer
 * PIN than before, or none yet); the owner role is not offered to a person with no e-mail account.
 */
export function ChangeRoleDialog({
  person,
  onClose,
  onChanged,
}: {
  person: StaffDto;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { adminEditor } = useServices();
  const tr = useT();
  const [form, setForm] = useState({ role: person.role, pin: '', pin2: '' });
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useDialogRun(() => {
    onChanged();
    onClose();
  });
  const needsPin = roleChangeNeedsPin(person, form.role);
  const problems = tried ? validateRoleChange(person, form) : [];
  const ownerBlocked = !canBecomeOwner(person);

  async function submit() {
    setTried(true);
    if (validateRoleChange(person, form).length > 0) return;
    await run(adminEditor.changeRole(person, form.role, roleChangePin(person, form)));
  }

  return (
    <Frame
      title={tr('settings.staff.changeRoleTitle', { name: person.displayName })}
      saving={saving}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p className="g-t-b" style={{ margin: 0 }}>
        {tr('settings.staff.changeRoleBody', { role: tr(`role.${person.role}`) })}
      </p>
      <RoleChoice
        name="change-role"
        value={form.role}
        disabledRoles={ownerBlocked ? ['owner'] : []}
        onChange={(role) => setForm({ ...form, role })}
      />
      {ownerBlocked ? (
        <p className="g-t-c" style={{ margin: 0 }}>
          {tr('settings.staff.changeRoleNoAccount')}
        </p>
      ) : null}
      {problems.includes('role') && form.role === person.role ? (
        <p className="gfield__msg gfield__msg--bad" role="alert" style={{ margin: 0 }}>
          {tr('settings.staff.changeRoleSame')}
        </p>
      ) : null}
      {needsPin ? (
        <>
          <TextField
            icon="lock"
            label={tr('settings.staff.changeRolePin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            hint={tr('settings.staff.changeRolePinHint', { min: minPinDigits(form.role) })}
            error={problems.includes('pin') ? tr('settings.staff.error.pin') : undefined}
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
            error={problems.includes('pin2') ? tr('settings.staff.error.pin2') : undefined}
            value={form.pin2}
            onChange={(pin2) => setForm({ ...form, pin2 })}
          />
        </>
      ) : null}
    </Frame>
  );
}
