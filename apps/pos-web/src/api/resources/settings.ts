/** Typed API client: the settings screens. */
import {
  bankAccountPatchInputSchema,
  bankAccountViewSchema,
  businessDaySettingsSchema,
  cashOpeningPatchInputSchema,
  cashOpeningSettingsSchema,
  deliveryPatchInputSchema,
  deliverySettingsSchema,
  govCopayPatchInputSchema,
  govCopayResponseSchema,
  lineOrderingPatchInputSchema,
  lineOrderingSchema,
  maskPromptpayId,
  numberingPatchInputSchema,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  paymentsPatchInputSchema,
  paymentsSettingsSchema,
  platformCommissionPatchInputSchema,
  platformCommissionSettingsSchema,
  printingPatchInputSchema,
  printingSettingsSchema,
  promptpayPatchInputSchema,
  promptpaySettingsSchema,
  putTaxProfileInputSchema,
  receiptPatchInputSchema,
  receiptSettingsSchema,
  settingResponseSchema,
  shopPatchInputSchema,
  shopSettingsSchema,
  taxProfileResponseSchema,
  taxReportQuerySchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

const yearQuery = (year: number) =>
  checked(taxReportQuerySchema.pick({ year: true }), { year }) as unknown as Record<string, string>;

export function makeSettings({ get, patch, put }: Transport) {
  /**
   * One settings resource: `read` is GET (never-saved settings answer the default at version 0),
   * `save` is PATCH, or PUT where the whole value is replaced. The body is checked against the
   * shared input schema first, so a body with no change or an unknown field never reaches the
   * network. Every save names the version it was built on (`expectedVersion`).
   */
  function settingsResource<V extends z.ZodType, I extends z.ZodType>(
    name: string,
    value: V,
    input: I,
    verb: 'patch' | 'put' = 'patch',
  ) {
    const path = `/v1/settings/${name}`;
    const schema = settingResponseSchema(value);
    return {
      read: async () => (await get({ path, schema, session: true, device: 'optional' })).data,
      save: async (body: z.input<I>) =>
        (
          await (verb === 'put' ? put : patch)({
            path,
            body: checked(input, body),
            schema,
            session: true,
            device: 'optional',
          })
        ).data,
    };
  }

  /**
   * The PromptPay ID as the settings screen sees it: masked, and nothing else. The server answers
   * (and echoes a change) with the ID in clear, so it is reduced here, before anything returns: no
   * screen, store or log can hold what this function never hands out. `save` is the one place a
   * full ID travels, from the person's own typing to the request.
   */
  const promptpayMasked = (() => {
    const path = '/v1/settings/promptpay';
    const schema = settingResponseSchema(promptpaySettingsSchema.nullable());
    const reduce = (answer: z.output<typeof schema>) => ({
      value:
        answer.value === null
          ? null
          : { idType: answer.value.idType, idMasked: maskPromptpayId(answer.value.idValue) },
      version: answer.version,
      rev: answer.rev,
      updatedAt: answer.updatedAt,
    });
    return {
      read: async () =>
        reduce((await get({ path, schema, session: true, device: 'optional' })).data),
      save: async (body: z.input<typeof promptpayPatchInputSchema>) =>
        reduce(
          (
            await patch({
              path,
              body: checked(promptpayPatchInputSchema, body),
              schema,
              session: true,
              device: 'optional',
            })
          ).data,
        ),
    };
  })();

  const settings = {
    shop: settingsResource('shop', shopSettingsSchema, shopPatchInputSchema),
    openingHours: settingsResource(
      'opening-hours',
      openingHoursSchema,
      openingHoursPatchInputSchema,
    ),
    numbering: settingsResource('numbering', businessDaySettingsSchema, numberingPatchInputSchema),
    payments: settingsResource('payments', paymentsSettingsSchema, paymentsPatchInputSchema),
    lineOrdering: settingsResource(
      'line-ordering',
      lineOrderingSchema,
      lineOrderingPatchInputSchema,
    ),
    /** Whether orders are sent to the print notebook (manager and owner; no step-up). */
    printing: settingsResource('printing', printingSettingsSchema, printingPatchInputSchema),
    promptpayMasked,
    /** What Grab and LINE MAN keep, in basis points (null: not set). Owner only, with a step-up. */
    platformCommission: settingsResource(
      'platform-commission',
      platformCommissionSettingsSchema,
      platformCommissionPatchInputSchema,
    ),
    /**
     * The start amount at the start of a business day (amount and date, null until set), the
     * start of the receipts-payments report's running net. Owner only to read, and to change with a step-up.
     */
    cashOpening: settingsResource(
      'cash-opening',
      cashOpeningSettingsSchema,
      cashOpeningPatchInputSchema,
    ),
    /**
     * The owner's tax inputs for one Buddhist Era year (extra allowances, method preference).
     * Read: owner only. Save replaces the whole profile of the year, owner only, with a step-up.
     */
    taxProfile: {
      read: async (year: number) =>
        (
          await get({
            path: '/v1/settings/tax-profile',
            query: yearQuery(year),
            schema: taxProfileResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
      save: async (year: number, body: z.input<typeof putTaxProfileInputSchema>) =>
        (
          await put({
            path: '/v1/settings/tax-profile',
            query: yearQuery(year),
            body: checked(putTaxProfileInputSchema, body),
            schema: taxProfileResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
    },
    /** The tax ID and address printed on receipts. Owner only to change, with a step-up. */
    receipt: settingsResource('receipt', receiptSettingsSchema, receiptPatchInputSchema),
    /** The receiving bank account, masked view only. Owner only to change, with a step-up. */
    bankAccount: settingsResource(
      'bank-account',
      bankAccountViewSchema,
      bankAccountPatchInputSchema,
    ),
    /** The ไทยช่วยไทย scheme (`scheme` null: none saved yet). Owner only, with a step-up. */
    govCopay: {
      read: async () =>
        (
          await get({
            path: '/v1/settings/gov-copay',
            schema: govCopayResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
      save: async (body: z.input<typeof govCopayPatchInputSchema>) =>
        (
          await patch({
            path: '/v1/settings/gov-copay',
            body: checked(govCopayPatchInputSchema, body),
            schema: govCopayResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
    },
    /** The buildings list as an editor reads and replaces it (PUT). */
    deliveryList: settingsResource(
      'delivery',
      deliverySettingsSchema,
      deliveryPatchInputSchema,
      'put',
    ),
    /** The buildings the shop delivers to (never-saved settings answer the default, version 0). */
    delivery: async () =>
      (
        await get({
          path: '/v1/settings/delivery',
          schema: settingResponseSchema(deliverySettingsSchema),
          session: true,
          device: 'optional',
        })
      ).data,
    /**
     * The shop's PromptPay ID IN CLEAR (roles with `settings.view`), for the offline QR (D-20).
     * Only the saved-ID store calls it. `value` is null when no ID was ever set. The answer is
     * a secret of the shop's account: never log it, never put it in an error or the page address.
     */
    promptpay: async () =>
      (
        await get({
          path: '/v1/settings/promptpay',
          schema: settingResponseSchema(promptpaySettingsSchema.nullable()),
          session: true,
          device: 'optional',
        })
      ).data,
  };

  return settings;
}
