/**
 * Device and staff management shapes (02 §6 "CRUD /v1/staff, /v1/devices"). Owner only, with
 * step-up. Responses never carry a token, hash, PIN or failure counter.
 */
import { z } from 'zod';
import { ownerPasswordSchema, pinSchema, pinSchemaFor } from './auth.ts';
import { DEVICE_KINDS, STAFF_ROLES } from './enums.ts';

const isoInstant = z.iso.datetime();
const version = z.number().int().min(1);
const displayName = z.string().trim().min(1).max(60);

export const idParamSchema = z.object({ id: z.uuid() });

// ---------- Devices ----------

export const deviceDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(DEVICE_KINDS),
  lastSeenAt: isoInstant.nullable(),
  revokedAt: isoInstant.nullable(),
  version,
});
export type DeviceDto = z.infer<typeof deviceDtoSchema>;

export const listDevicesResponseSchema = z.object({ devices: z.array(deviceDtoSchema) });
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;

/**
 * The owner took over or cleared another person's offline outbox entries on a device. Counts only:
 * no names, no order contents, no free text. `clientRequestId` makes a retry write nothing more.
 */
export const OUTBOX_RECOVERY_ACTIONS = ['take_over', 'clear'] as const;
export const outboxRecoveryInputSchema = z
  .strictObject({
    clientRequestId: z.uuid(),
    action: z.enum(OUTBOX_RECOVERY_ACTIONS),
    orders: z.number().int().min(0).max(1000),
    payments: z.number().int().min(0).max(1000),
  })
  .refine((v) => v.orders + v.payments > 0, {
    message: 'there is nothing to recover',
    path: ['orders'],
  });
export type OutboxRecoveryInput = z.infer<typeof outboxRecoveryInputSchema>;

export const outboxRecoveryResponseSchema = z.object({
  deviceId: z.uuid(),
  action: z.enum(OUTBOX_RECOVERY_ACTIONS),
  orders: z.number().int(),
  payments: z.number().int(),
});
export type OutboxRecoveryResponse = z.infer<typeof outboxRecoveryResponseSchema>;

// ---------- Staff ----------

export const staffDtoSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  role: z.enum(STAFF_ROLES),
  active: z.boolean(),
  /** The sign-in e-mail of an invited person; null for PIN-only staff (no e-mail account). */
  email: z.string().nullable(),
  hasPin: z.boolean(),
  /** While in the future, PIN sign-in is locked (wrong tries). The UI compares with its clock. */
  pinLockedUntil: isoInstant.nullable(),
  version,
});
export type StaffDto = z.infer<typeof staffDtoSchema>;

export const listStaffResponseSchema = z.object({ staff: z.array(staffDtoSchema) });
export type ListStaffResponse = z.infer<typeof listStaffResponseSchema>;

/** Roles that can be created over the API. The owner is created once, by `owner:create`. */
const CREATABLE_ROLES = ['manager', 'cashier', 'kitchen'] as const;

export const createStaffInputSchema = z
  .strictObject({
    displayName,
    role: z.enum(CREATABLE_ROLES),
    pin: pinSchema,
  })
  .refine((v) => pinSchemaFor(v.role).safeParse(v.pin).success, {
    message: 'the PIN is too short for this role',
    path: ['pin'],
  });
export type CreateStaffInput = z.infer<typeof createStaffInputSchema>;

/** 4 to 6 digits here; the minimum for the person's role is checked once their role is known. */
export const setStaffPinInputSchema = z.strictObject({ pin: pinSchema });
export type SetStaffPinInput = z.infer<typeof setStaffPinInputSchema>;

/** Name and active flag only. A role change would need a PIN of the new role's length. */
export const patchStaffInputSchema = z
  .strictObject({
    expectedVersion: version,
    displayName: displayName.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.active !== undefined, {
    message: 'give displayName or active',
    path: ['displayName'],
  });
export type PatchStaffInput = z.infer<typeof patchStaffInputSchema>;

// ---------- Role change (D-23) ----------

/**
 * Owner only, with step-up. A PIN is required when the new role's minimum PIN length is longer
 * than the old role's (or the person has no PIN and the new role is not owner); the service checks
 * that once it knows the old role. A PIN given here must always fit the NEW role.
 */
export const changeRoleInputSchema = z
  .strictObject({
    expectedVersion: version,
    role: z.enum(STAFF_ROLES),
    pin: pinSchema.optional(),
  })
  .refine((v) => v.pin === undefined || pinSchemaFor(v.role).safeParse(v.pin).success, {
    message: 'the PIN is too short for this role',
    path: ['pin'],
  });
export type ChangeRoleInput = z.infer<typeof changeRoleInputSchema>;

// ---------- Invites (D-23) ----------

const inviteEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** What the owner sees of an open invite. Accepted and revoked invites are not listed. */
export const INVITE_STATUSES = ['open', 'expired'] as const;
export const inviteDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(STAFF_ROLES),
  displayName: z.string().nullable(),
  createdAt: isoInstant,
  expiresAt: isoInstant,
  status: z.enum(INVITE_STATUSES),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;

export const listInvitesResponseSchema = z.object({ invites: z.array(inviteDtoSchema) });
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

/** Any role, the owner role included: invites are the only way to make a co-owner. */
export const createInviteInputSchema = z.strictObject({
  email: inviteEmail,
  role: z.enum(STAFF_ROLES),
  displayName: displayName.optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

/** `token` is shown once; the UI builds the link `<origin>/invite#<token>`. Only its hash is stored. */
export const createInviteResponseSchema = inviteDtoSchema.extend({ token: z.string() });
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

/** The token of a link is not a secret of the person who types it, but it is never logged. */
const inviteToken = z.string().min(1).max(200);

export const invitePreviewInputSchema = z.strictObject({ token: inviteToken });
export type InvitePreviewInput = z.infer<typeof invitePreviewInputSchema>;

export const invitePreviewResponseSchema = z.object({
  email: z.string(),
  role: z.enum(STAFF_ROLES),
  displayName: z.string().nullable(),
  /** A fresh authenticator secret for this invite. The invitee enrols it, then types a code. */
  totp: z.object({ secretBase32: z.string(), otpauthUri: z.string() }),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponseSchema>;

/**
 * The role is the invite's, never the body's. The PIN is 4 to 6 digits here; its minimum for the
 * invite's role is checked once the role is known (pinSchemaFor).
 */
export const acceptInviteInputSchema = z.strictObject({
  token: inviteToken,
  displayName,
  password: ownerPasswordSchema,
  pin: pinSchema,
  totpCode: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInputSchema>;

/** Shown once: the codes are stored only as hashes. */
export const acceptInviteResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
