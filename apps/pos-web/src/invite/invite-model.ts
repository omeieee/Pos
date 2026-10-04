/**
 * The invite page's form as plain data (D-23): what is typed, what is sent. The rules are the
 * shared schemas (a 12-character password, a PIN of the invited role's length, a 6-digit app
 * code), not copies of them.
 */
import {
  type AcceptInviteInput,
  acceptInviteInputSchema,
  PIN_MIN_DIGITS,
  pinSchemaFor,
  type StaffRole,
} from '@sds/shared';

export interface InviteDraft {
  displayName: string;
  password: string;
  pin: string;
  /** The PIN typed a second time. */
  pin2: string;
  /** The 6-digit code from the authenticator app. */
  code: string;
}

export const emptyInviteDraft: InviteDraft = {
  displayName: '',
  password: '',
  pin: '',
  pin2: '',
  code: '',
};

export type InviteFormField = 'displayName' | 'password' | 'pin' | 'pin2' | 'code';

export type PasswordStrength = 'short' | 'fair' | 'strong';

const STRONG_LENGTH = 16;

/** A hint while typing: below the shared minimum is `short`; a long passphrase is `strong`. */
export function passwordStrength(password: string): PasswordStrength {
  if (!acceptInviteInputSchema.shape.password.safeParse(password).success) return 'short';
  return password.length >= STRONG_LENGTH ? 'strong' : 'fair';
}

/** The app code is digits only, at most 6; pasted spaces and dashes are dropped. */
export const sanitizeCode = (raw: string): string => raw.replace(/\D/g, '').slice(0, 6);

/** The PIN is digits only, at most 6. */
export const sanitizePin = (raw: string): string => raw.replace(/\D/g, '').slice(0, 6);

/** Which hint to show under the PIN: all 6 digits (owner, manager) or 4 to 6. */
export const pinHintDigits = (role: StaffRole): 6 | 4 => (PIN_MIN_DIGITS[role] >= 6 ? 6 : 4);

export function inviteProblems(role: StaffRole, draft: InviteDraft): InviteFormField[] {
  const problems: InviteFormField[] = [];
  const name = draft.displayName.trim();
  if (name === '' || name.length > 60) problems.push('displayName');
  if (!acceptInviteInputSchema.shape.password.safeParse(draft.password).success) {
    problems.push('password');
  }
  if (!pinSchemaFor(role).safeParse(draft.pin).success) problems.push('pin');
  else if (draft.pin !== draft.pin2) problems.push('pin2');
  if (!/^\d{6}$/.test(draft.code)) problems.push('code');
  return problems;
}

/** The accept body for a valid form (what the shared schema accepts), else null. */
export function buildAccept(
  token: string,
  role: StaffRole,
  draft: InviteDraft,
): AcceptInviteInput | null {
  if (inviteProblems(role, draft).length > 0) return null;
  const parsed = acceptInviteInputSchema.safeParse({
    token,
    displayName: draft.displayName.trim(),
    password: draft.password,
    pin: draft.pin,
    totpCode: draft.code,
  });
  return parsed.success ? parsed.data : null;
}
