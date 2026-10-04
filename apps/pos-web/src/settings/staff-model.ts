/**
 * The rules of the staff forms, outside React. The shared schemas decide what a name and a PIN
 * may be (an owner or manager needs all 6 digits, counter and kitchen staff 4 to 6). The first owner
 * is made once from the command line; every other owner comes from an invite (D-23). Nobody changes
 * their own account here: the API answers SELF_CHANGE, and the screen says so before asking.
 */
import {
  type CreateInviteInput,
  type CreateStaffInput,
  createInviteInputSchema,
  createStaffInputSchema,
  PIN_MIN_DIGITS,
  pinSchemaFor,
  type StaffDto,
  type StaffRole,
} from '@sds/shared';

/** The roles that can be created over the API. */
export const CREATABLE_ROLES = ['manager', 'cashier', 'kitchen'] as const;
export type CreatableRole = (typeof CREATABLE_ROLES)[number];

export interface NewStaffForm {
  displayName: string;
  role: CreatableRole;
  pin: string;
  /** The PIN typed a second time. */
  pin2: string;
}
export type NewStaffField = 'displayName' | 'pin' | 'pin2';

/** What is wrong with a PIN for a role, and with the second typing. */
export function pinProblems(role: StaffRole, pin: string, pin2: string): ('pin' | 'pin2')[] {
  if (!pinSchemaFor(role).safeParse(pin).success) return ['pin'];
  return pin === pin2 ? [] : ['pin2'];
}

export function validateNewStaff(form: NewStaffForm): NewStaffField[] {
  const errors: NewStaffField[] = [];
  const name = form.displayName.trim();
  if (name === '' || name.length > 60) errors.push('displayName');
  errors.push(...pinProblems(form.role, form.pin, form.pin2));
  return errors;
}

/** The create body for a valid form (what the shared schema accepts), else null. */
export function buildNewStaff(form: NewStaffForm): CreateStaffInput | null {
  if (validateNewStaff(form).length > 0) return null;
  const parsed = createStaffInputSchema.safeParse({
    displayName: form.displayName.trim(),
    role: form.role,
    pin: form.pin,
  });
  return parsed.success ? parsed.data : null;
}

/** The roles an invite or a role change can give, safest first; the owner role is last on purpose. */
export const INVITE_ROLES = [
  'cashier',
  'kitchen',
  'manager',
  'owner',
] as const satisfies readonly StaffRole[];

export interface InviteForm {
  email: string;
  displayName: string;
  role: StaffRole;
}
export type InviteField = 'email' | 'displayName';

export function validateInvite(form: InviteForm): InviteField[] {
  const errors: InviteField[] = [];
  if (!createInviteInputSchema.shape.email.safeParse(form.email).success) errors.push('email');
  if (form.displayName.trim().length > 60) errors.push('displayName');
  return errors;
}

/** The create body for a valid form (what the shared schema accepts), else null. */
export function buildInvite(form: InviteForm): CreateInviteInput | null {
  if (validateInvite(form).length > 0) return null;
  const name = form.displayName.trim();
  const parsed = createInviteInputSchema.safeParse({
    email: form.email,
    role: form.role,
    ...(name === '' ? {} : { displayName: name }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Does moving this person to `role` need a PIN typed now? Same rule as the API's role change: the
 * role changes and either its PIN is longer than the old one's, or the person has no PIN (and the
 * new role is not owner, who steps up with a password). A hint only: the API decides.
 */
export function roleChangeNeedsPin(person: Pick<StaffDto, 'role' | 'hasPin'>, role: StaffRole) {
  if (role === person.role) return false;
  return PIN_MIN_DIGITS[role] > PIN_MIN_DIGITS[person.role] || (!person.hasPin && role !== 'owner');
}

/** A person with no e-mail account (PIN only) cannot become an owner. */
export const canBecomeOwner = (person: Pick<StaffDto, 'email'>): boolean => person.email !== null;

export type RoleChangeField = 'role' | 'pin' | 'pin2';

export function validateRoleChange(
  person: Pick<StaffDto, 'role' | 'hasPin' | 'email'>,
  form: { role: StaffRole; pin: string; pin2: string },
): RoleChangeField[] {
  if (form.role === person.role) return ['role'];
  if (form.role === 'owner' && !canBecomeOwner(person)) return ['role'];
  if (roleChangeNeedsPin(person, form.role)) return pinProblems(form.role, form.pin, form.pin2);
  return [];
}

/** The PIN to send with a role change, or undefined when none is needed. */
export function roleChangePin(
  person: Pick<StaffDto, 'role' | 'hasPin'>,
  form: { role: StaffRole; pin: string },
): string | undefined {
  return roleChangeNeedsPin(person, form.role) ? form.pin : undefined;
}

/** The shortest PIN of a role, for the hint under the field. */
export const minPinDigits = (role: StaffRole): number => PIN_MIN_DIGITS[role];

/** While in the future, PIN sign-in is locked (wrong tries). */
export const isPinLocked = (person: Pick<StaffDto, 'pinLockedUntil'>, nowMs: number): boolean =>
  person.pinLockedUntil !== null && Date.parse(person.pinLockedUntil) > nowMs;

export interface StaffDisplayState {
  /** This row is the signed-in person: nothing here changes their own account. */
  isSelf: boolean;
  /** Rename, set a PIN and change the role. Never on yourself. */
  canEdit: boolean;
  canChangeRole: boolean;
  canDeactivate: boolean;
  canActivate: boolean;
  locked: boolean;
  noPin: boolean;
}

export function staffDisplayState(
  person: StaffDto,
  nowMs: number,
  selfId: string | null = null,
): StaffDisplayState {
  const isSelf = person.id === selfId;
  return {
    isSelf,
    canEdit: !isSelf,
    canChangeRole: !isSelf,
    canDeactivate: !isSelf && person.active,
    canActivate: !isSelf && !person.active,
    locked: isPinLocked(person, nowMs),
    noPin: !person.hasPin,
  };
}
