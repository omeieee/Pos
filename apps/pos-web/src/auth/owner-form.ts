/**
 * The owner's credential form as plain data: what is typed, what is sent. The rules (valid
 * e-mail, 6-digit code, exactly one second factor) are the shared schemas, not copies of them.
 */
import { ownerLoginInputSchema, ownerStepUpInputSchema } from '@sds/shared';
import type { OwnerLoginRequest, OwnerStepUpRequest } from '../api/client.ts';

export interface OwnerDraft {
  email: string;
  password: string;
  /** The 6-digit code from the authenticator app. */
  code: string;
  recoveryCode: string;
  /** Which of the two second factors the person is using. */
  useRecovery: boolean;
}

export const emptyOwnerDraft: OwnerDraft = {
  email: '',
  password: '',
  code: '',
  recoveryCode: '',
  useRecovery: false,
};

/** The app code is digits only, at most 6; pasted spaces and dashes are dropped. */
export function sanitizeAppCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

function secondFactor(draft: OwnerDraft): { totp: string } | { recoveryCode: string } {
  return draft.useRecovery ? { recoveryCode: draft.recoveryCode } : { totp: draft.code };
}

/** The sign-in request, or null while the form is not valid yet. */
export function ownerLoginRequest(draft: OwnerDraft): OwnerLoginRequest | null {
  const input = { email: draft.email, password: draft.password, ...secondFactor(draft) };
  return ownerLoginInputSchema.safeParse(input).success ? input : null;
}

/** The step-up request (no e-mail: the session already knows who the owner is). */
export function ownerStepUpRequest(draft: OwnerDraft): OwnerStepUpRequest | null {
  const input = { password: draft.password, ...secondFactor(draft) };
  return ownerStepUpInputSchema.safeParse(input).success ? input : null;
}

/** Wrong details clear the secrets, keep the e-mail, and keep the chosen second factor. */
export function afterFailedAttempt(draft: OwnerDraft): OwnerDraft {
  return { ...draft, password: '', code: '', recoveryCode: '' };
}
