/** Typed API client: staff, devices and invites (owner only). */
import {
  changeRoleInputSchema,
  createInviteInputSchema,
  createInviteResponseSchema,
  createStaffInputSchema,
  deviceDtoSchema,
  idParamSchema,
  listDevicesResponseSchema,
  listInvitesResponseSchema,
  listStaffResponseSchema,
  patchStaffInputSchema,
  setStaffPinInputSchema,
  staffDtoSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export function makeAdmin({ get, post, patch }: Transport) {
  /**
   * Devices and staff (owner only). Every one of these routes asks for a fresh step-up, even the
   * lists, so callers go through `auth.runSensitive`. The staff routes take no idempotency key (the
   * API refuses extra fields): a lost answer to a create is settled by reading the list again, and
   * nothing here retries by itself. A PIN is only in the request body, never in a URL or an error.
   */
  const admin = {
    devices: async () =>
      (
        await get({
          path: '/v1/devices',
          schema: listDevicesResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    revokeDevice: async (id: string) =>
      (
        await post({
          path: `/v1/devices/${checked(idParamSchema, { id }).id}/revoke`,
          schema: deviceDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    staff: async () =>
      (
        await get({
          path: '/v1/staff',
          schema: listStaffResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    createStaff: async (input: z.input<typeof createStaffInputSchema>) =>
      (
        await post({
          path: '/v1/staff',
          body: checked(createStaffInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    patchStaff: async (id: string, input: z.input<typeof patchStaffInputSchema>) =>
      (
        await patch({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}`,
          body: checked(patchStaffInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /** A role change; a PIN of the new role only when it needs one (see `roleChangeNeedsPin`). */
    changeStaffRole: async (id: string, input: z.input<typeof changeRoleInputSchema>) =>
      (
        await post({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}/role`,
          body: checked(changeRoleInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    invites: async () =>
      (
        await get({
          path: '/v1/staff/invites',
          schema: listInvitesResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /** The answer carries the invite token once: show the link, keep the token nowhere else. */
    createInvite: async (input: z.input<typeof createInviteInputSchema>) =>
      (
        await post({
          path: '/v1/staff/invites',
          body: checked(createInviteInputSchema, input),
          schema: createInviteResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    revokeInvite: async (id: string) => {
      await post<void>({
        path: `/v1/staff/invites/${checked(idParamSchema, { id }).id}/revoke`,
        session: true,
        device: 'optional',
      });
    },
    setStaffPin: async (id: string, input: z.input<typeof setStaffPinInputSchema>) =>
      (
        await post({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}/pin`,
          body: checked(setStaffPinInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
  };

  return admin;
}
