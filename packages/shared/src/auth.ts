/**
 * Auth request and response shapes (D-17, 02 §6–7). Pure Zod; hashing and tokens live in apps/api.
 * Secrets (PIN, password, codes) are only ever validated here, never logged or echoed.
 */
import { z } from 'zod';
import { DEVICE_KINDS, STAFF_ROLES } from './enums.ts';
import { PERMISSIONS } from './permissions.ts';

/** Staff PIN: 4–6 digits (D-17). */
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'must be 4 to 6 digits');

/** Applied only when a password is chosen; login accepts any non-empty value (up to the cap). */
export const ownerPasswordSchema = z.string().min(12).max(256);

const loginPasswordSchema = z.string().min(1).max(256);
const totpCodeSchema = z.string().regex(/^\d{6}$/, 'must be 6 digits');
/** Recovery codes look like ABCD-EFGH-JKLM-NPQR; the server ignores case, dashes and spaces. */
const recoveryCodeSchema = z
  .string()
  .trim()
  .min(8)
  .max(40)
  .regex(/^[A-Za-z0-9 -]+$/);

const exactlyOneSecondFactor = (v: {
  totp?: string | undefined;
  recoveryCode?: string | undefined;
}) => (v.totp === undefined) !== (v.recoveryCode === undefined);
const secondFactorMessage = { message: 'give either totp or recoveryCode', path: ['totp'] };

export const registerDeviceInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(DEVICE_KINDS),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;

export const pinLoginInputSchema = z.object({ staffId: z.uuid(), pin: pinSchema });
export type PinLoginInput = z.infer<typeof pinLoginInputSchema>;

export const ownerLoginInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: loginPasswordSchema,
    totp: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine(exactlyOneSecondFactor, secondFactorMessage);
export type OwnerLoginInput = z.infer<typeof ownerLoginInputSchema>;

/** Step-up for the owner role: password again plus a second factor (R4). */
export const ownerStepUpInputSchema = z
  .object({
    password: loginPasswordSchema,
    totp: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine(exactlyOneSecondFactor, secondFactorMessage);
export type OwnerStepUpInput = z.infer<typeof ownerStepUpInputSchema>;

/** Step-up for every other role: the PIN again (they have no password). */
export const staffStepUpInputSchema = z.object({ pin: pinSchema });
export type StaffStepUpInput = z.infer<typeof staffStepUpInputSchema>;

// ---------- Responses ----------

export const sessionPrincipalSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  role: z.enum(STAFF_ROLES),
});

export const sessionResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.iso.datetime(),
  idleTimeoutSeconds: z.number().int().positive(),
  staff: sessionPrincipalSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const registerDeviceResponseSchema = z.object({
  device: z.object({ id: z.uuid(), name: z.string(), kind: z.enum(DEVICE_KINDS) }),
  /** Shown once. The server keeps only a hash. */
  deviceToken: z.string(),
});
export type RegisterDeviceResponse = z.infer<typeof registerDeviceResponseSchema>;

export const stepUpResponseSchema = z.object({ stepUpUntil: z.iso.datetime() });
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>;

export const authMeResponseSchema = z.object({
  staff: sessionPrincipalSchema,
  deviceId: z.uuid().nullable(),
  permissions: z.array(z.enum(PERMISSIONS)),
  expiresAt: z.iso.datetime(),
  stepUpUntil: z.iso.datetime().nullable(),
});
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;

/** The PIN screen's tiles: who can sign in on this device. */
export const authStaffListResponseSchema = z.object({ staff: z.array(sessionPrincipalSchema) });
export type AuthStaffListResponse = z.infer<typeof authStaffListResponseSchema>;
