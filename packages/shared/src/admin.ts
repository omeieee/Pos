/**
 * Device and staff management shapes (02 §6 "CRUD /v1/staff, /v1/devices"). Owner only, with
 * step-up. Responses never carry a token, hash, PIN or failure counter.
 */
import { z } from 'zod';
import { pinSchema, pinSchemaFor } from './auth.ts';
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
