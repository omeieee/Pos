/**
 * The rules of the PromptPay ID form, outside React. The shared schema decides what a valid ID is
 * (a 0 and nine digits, 13 digits, 15 digits); nothing here keeps an ID: it is read from what the
 * person types, shown masked, and handed to the one save call.
 */
import {
  maskPromptpayId,
  type PaymentDto,
  type PromptpayPatchInput,
  type PromptpaySettings,
  promptpaySettingsSchema,
} from '@sds/shared';

/** What the person typed: the kind of ID and its digits as text. */
export interface PromptpayDraft {
  idType: PromptpaySettings['idType'];
  idValue: string;
}

/** Spaces and hyphens people put between digits are not part of the ID. */
export const normalizeIdText = (text: string): string => text.replace(/[\s-]/g, '');

export type PromptpayRead = { ok: true; id: PromptpaySettings } | { ok: false };

export function readPromptpayDraft(draft: PromptpayDraft): PromptpayRead {
  const parsed = promptpaySettingsSchema.safeParse({
    idType: draft.idType,
    idValue: normalizeIdText(draft.idValue),
  });
  return parsed.success ? { ok: true, id: parsed.data } : { ok: false };
}

/** The ID with only its last characters visible: the only form the screen shows. */
export const previewMasked = (id: PromptpaySettings): string => maskPromptpayId(id.idValue);

/** The save: the version the screen saw (0: never saved) and the whole new ID. */
export const buildPromptpayInput = (
  version: number,
  id: PromptpaySettings,
): PromptpayPatchInput => ({ expectedVersion: version, ...id });

/**
 * PromptPay payments still waiting for the shop (pending or claimed): the same two states the
 * server counts for its own warning. It counts what this device holds, so it can miss a payment
 * that never reached it; the screen says so.
 */
export function openPromptpayCount(payments: ReadonlyMap<string, PaymentDto>): number {
  let count = 0;
  for (const payment of payments.values()) {
    if (
      payment.method === 'promptpay' &&
      (payment.status === 'pending' || payment.status === 'claimed')
    ) {
      count += 1;
    }
  }
  return count;
}
