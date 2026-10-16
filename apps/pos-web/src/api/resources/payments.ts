/** Typed API client: payments: start, moves, QR, slip picture. */
import {
  changePaymentMethodInputSchema,
  changePaymentMethodResultSchema,
  claimPaymentInputSchema,
  confirmPaymentInputSchema,
  createPaymentInputSchema,
  orderPaymentsResponseSchema,
  paymentIdParamSchema,
  paymentQrUrlResponseSchema,
  paymentReasonInputSchema,
  paymentResultSchema,
  slipBlockClearInputSchema,
  slipFlagClearInputSchema,
  slipFlagResponseSchema,
  slipRecheckInputSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { joinUrl } from '../../platform/config.ts';
import { ApiClientError } from '../errors.ts';
import { checked, errorFromResponse, newClientRequestId, type Transport } from '../http.ts';

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'clientRequestId'> : never;
export type NewPaymentInput = WithoutRequestId<z.input<typeof createPaymentInputSchema>>;
export type ChangePaymentInput = WithoutRequestId<z.input<typeof changePaymentMethodInputSchema>>;

export function makePayments({ get, post, orderPath, options, doFetch, buildUrl }: Transport) {
  const paymentPath = (id: string) => `/v1/payments/${checked(paymentIdParamSchema, { id }).id}`;

  /**
   * Payment calls never carry an amount: the server charges the order total. Cash sends only what
   * the customer handed over. A caller that may retry creates `clientRequestId` once and passes it
   * on every attempt (the server then answers the original, `replay: true`).
   */
  const payments = {
    create: async (
      orderId: string,
      input: NewPaymentInput,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `${orderPath(orderId)}/payments`,
        body: checked(createPaymentInputSchema, { ...input, clientRequestId }),
        schema: paymentResultSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { result: data, replay: status === 200, clientRequestId };
    },

    list: async (orderId: string) =>
      (
        await get({
          path: `${orderPath(orderId)}/payments`,
          schema: orderPaymentsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * Asks the server to check the claimed payment's slip with the bank again (D-27). Answers with
     * the payment list view, as `list` does. Each call is a fresh attempt, so a new key by default.
     */
    slipRecheck: async (id: string, options?: { clientRequestId?: string }) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      return (
        await post({
          path: `${paymentPath(id)}/slip-recheck`,
          body: checked(slipRecheckInputSchema, { clientRequestId }),
          schema: orderPaymentsResponseSchema,
          session: true,
          device: 'optional',
          headers: { 'Idempotency-Key': clientRequestId },
        })
      ).data;
    },

    /**
     * The owner lifts the slip block of the order this payment belongs to (owner + fresh step-up, so
     * call it through `auth.runSensitive`). Answers with the payment list view.
     */
    slipBlockClear: async (id: string, input: z.input<typeof slipBlockClearInputSchema>) =>
      (
        await post({
          path: `${paymentPath(id)}/slip-block/clear`,
          body: checked(slipBlockClearInputSchema, input),
          schema: orderPaymentsResponseSchema,
          session: true,
          device: 'optional',
          headers: { 'Idempotency-Key': input.clientRequestId },
        })
      ).data,

    /**
     * The owner clears a customer's slip flag (owner + fresh step-up). It sits here because the
     * staff app reaches it from the payment screen only.
     */
    slipFlagClear: async (customerId: string, input: z.input<typeof slipFlagClearInputSchema>) =>
      (
        await post({
          path: `/v1/customers/${encodeURIComponent(customerId)}/slip-flag/clear`,
          body: checked(slipFlagClearInputSchema, input),
          schema: slipFlagResponseSchema,
          session: true,
          device: 'optional',
          headers: { 'Idempotency-Key': input.clientRequestId },
        })
      ).data,

    claim: async (id: string, input: z.input<typeof claimPaymentInputSchema> = {}) =>
      paymentMove(`${paymentPath(id)}/claim`, checked(claimPaymentInputSchema, input)),

    confirm: async (id: string, input: z.input<typeof confirmPaymentInputSchema> = {}) =>
      paymentMove(`${paymentPath(id)}/confirm`, checked(confirmPaymentInputSchema, input)),

    cancelClaimed: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/cancel-claimed`, checked(paymentReasonInputSchema, input)),

    void: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/void`, checked(paymentReasonInputSchema, input)),

    refund: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/refund`, checked(paymentReasonInputSchema, input)),

    changeMethod: async (
      id: string,
      input: ChangePaymentInput,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `${paymentPath(id)}/change-method`,
        body: checked(changePaymentMethodInputSchema, { ...input, clientRequestId }),
        schema: changePaymentMethodResultSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { result: data, replay: status === 200, clientRequestId };
    },

    /**
     * A short-lived signed link for an `<img>` (it cannot send a header). The link is the only
     * authentication of the picture and is worth a few minutes: never log or store it. Ask again
     * whenever the QR is shown, and after a PromptPay settings change.
     */
    qrUrl: async (id: string) => {
      const link = (
        await get({
          path: `${paymentPath(id)}/qr-url`,
          schema: paymentQrUrlResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
      return { ...link, url: joinUrl(options.baseUrl, link.url) };
    },

    /**
     * The customer's slip picture, as a Blob. It is fetched with the session header (an `<img>`
     * cannot send one), shown from a blob URL and never stored. A missing slip is `SLIP_NOT_FOUND`.
     */
    slip: async (id: string): Promise<Blob> => {
      const bearer = options.getSessionToken();
      if (!bearer) throw new ApiClientError('UNAUTHENTICATED', { status: 401 });
      const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
      const deviceToken = options.getDeviceToken();
      if (deviceToken) headers['X-Device-Token'] = deviceToken;
      let response: Response;
      try {
        response = await doFetch(buildUrl(`${paymentPath(id)}/slip`), {
          method: 'GET',
          headers,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        throw new ApiClientError('NETWORK');
      }
      if (!response.ok) throw errorFromResponse(response.status, await response.text());
      return response.blob();
    },
  };

  async function paymentMove(path: string, body: unknown) {
    return (
      await post({
        path,
        body,
        schema: paymentResultSchema,
        session: true,
        device: 'optional',
      })
    ).data;
  }

  return payments;
}
