/** Typed API client: sign-in, step-up, logout and the sign-in lists. */
import {
  acceptInviteInputSchema,
  acceptInviteResponseSchema,
  authMeResponseSchema,
  authStaffListResponseSchema,
  invitePreviewInputSchema,
  invitePreviewResponseSchema,
  ownerLoginInputSchema,
  ownerStepUpInputSchema,
  pinLoginInputSchema,
  registerDeviceInputSchema,
  registerDeviceResponseSchema,
  sessionResponseSchema,
  staffStepUpInputSchema,
  stepUpResponseSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export type OwnerLoginRequest = z.input<typeof ownerLoginInputSchema>;
export type OwnerStepUpRequest = z.input<typeof ownerStepUpInputSchema>;

export function makeAuth({ get, post }: Transport) {
  const auth = {
    /** The PIN screen's tiles. Needs this device's token, no session. */
    listStaff: async () =>
      (
        await get({
          path: '/v1/auth/staff',
          schema: authStaffListResponseSchema,
          device: 'required',
        })
      ).data,

    pinLogin: async (input: z.input<typeof pinLoginInputSchema>) =>
      (
        await post({
          path: '/v1/auth/pin',
          body: checked(pinLoginInputSchema, input),
          schema: sessionResponseSchema,
          device: 'required',
        })
      ).data,

    /**
     * Owner password sign-in. The device token is sent when there is one (the session is then
     * recorded against the device) but the call also works on an unregistered device.
     */
    ownerLogin: async (input: OwnerLoginRequest) =>
      (
        await post({
          path: '/v1/auth/owner',
          body: checked(ownerLoginInputSchema, input),
          schema: sessionResponseSchema,
          device: 'optional',
        })
      ).data,

    /** Owner + a fresh step-up. The one-time device token is in the answer; keep it. */
    registerDevice: async (input: z.input<typeof registerDeviceInputSchema>) =>
      (
        await post({
          path: '/v1/auth/device',
          body: checked(registerDeviceInputSchema, input),
          schema: registerDeviceResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** The owner's step-up: password plus an app code or a recovery code. */
    stepUpOwner: async (input: OwnerStepUpRequest) =>
      (
        await post({
          path: '/v1/auth/step-up',
          body: checked(ownerStepUpInputSchema, input),
          schema: stepUpResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Any other role's step-up: the PIN again. */
    stepUpStaff: async (input: z.input<typeof staffStepUpInputSchema>) =>
      (
        await post({
          path: '/v1/auth/step-up',
          body: checked(staffStepUpInputSchema, input),
          schema: stepUpResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The invite link's two public calls (D-23): the token in the body is the only credential, so
     * no session and no device token travel with them. The token is never put in a URL or an
     * error. A preview replaces the authenticator secret stored for the invite: call it once.
     */
    invitePreview: async (input: z.input<typeof invitePreviewInputSchema>) =>
      (
        await post({
          path: '/v1/auth/invite/preview',
          body: checked(invitePreviewInputSchema, input),
          schema: invitePreviewResponseSchema,
        })
      ).data,

    inviteAccept: async (input: z.input<typeof acceptInviteInputSchema>) =>
      (
        await post({
          path: '/v1/auth/invite/accept',
          body: checked(acceptInviteInputSchema, input),
          schema: acceptInviteResponseSchema,
        })
      ).data,

    me: async () =>
      (
        await get({
          path: '/v1/auth/me',
          schema: authMeResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** `sessionToken` lets the store clear its own copy first and still revoke this session. */
    logout: async (sessionToken?: string) => {
      await post<void>({
        path: '/v1/auth/logout',
        session: sessionToken ?? true,
        device: 'optional',
      });
    },
  };

  return auth;
}
