/**
 * The rules of the staff forms, outside React. The shared schemas decide what a name and a PIN
 * may be (a manager needs all 6 digits, counter and kitchen staff 4 to 6); the owner is created
 * once from the command line and cannot be added or changed here.
 */
import {
  type CreateStaffInput,
  createStaffInputSchema,
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

/** While in the future, PIN sign-in is locked (wrong tries). */
export const isPinLocked = (person: Pick<StaffDto, 'pinLockedUntil'>, nowMs: number): boolean =>
  person.pinLockedUntil !== null && Date.parse(person.pinLockedUntil) > nowMs;

export interface StaffDisplayState {
  /** Rename and set a PIN. Never for the owner. */
  canEdit: boolean;
  canDeactivate: boolean;
  canActivate: boolean;
  locked: boolean;
  noPin: boolean;
}

export function staffDisplayState(person: StaffDto, nowMs: number): StaffDisplayState {
  const isOwner = person.role === 'owner';
  return {
    canEdit: !isOwner,
    canDeactivate: !isOwner && person.active,
    canActivate: !isOwner && !person.active,
    locked: isPinLocked(person, nowMs),
    noPin: !person.hasPin,
  };
}
