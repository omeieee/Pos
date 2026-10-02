/**
 * The rules of the offline PromptPay QR (D-20) as pure functions: what the device keeps, when the
 * saved ID may no longer be used, and how the payload for an amount is made. No React, no I/O.
 *
 * The saved ID is the REAL PromptPay ID, so it lives in one local-store record of its own
 * (`PROMPTPAY_CACHE_KEY`), never in the catalogue copy, the token store or the outbox. Nothing in
 * this file logs it or puts it in an error: a refusal is a reason code, nothing else.
 *
 * Why a QR is refused (the owner accepted the risk of an old account only with these limits):
 * - `none`: no ID has ever been saved on this device (or it was cleared): reconnect once;
 * - `stale`: the server said the ID changed (or the saved copy could not be confirmed after that
 *   notice): the old account must not be shown;
 * - `tooOld`: saved more than 24 hours ago (an ID changed while this device was offline would
 *   otherwise be used for ever), or saved "in the future" (the clock was turned back);
 * - `badAmount`: zero, negative, not a whole number of satang or too large: no QR for it.
 */
import { promptpayPayload } from '@sds/promptpay';
import { promptpaySettingsSchema, satang } from '@sds/shared';
import { z } from 'zod';

export const PROMPTPAY_CACHE_KEY = 'promptpay.id';
/** Bump when the saved record changes shape: an older record is then dropped, not read. */
export const PROMPTPAY_CACHE_SCHEMA = 1;
/** The longest a saved ID may be used without being confirmed by the server again. */
export const OFFLINE_QR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A clock turned back by up to this much (an adjustment) is not treated as a trick. */
export const CLOCK_BACK_TOLERANCE_MS = 5 * 60 * 1000;

const savedSchema = z.object({
  v: z.number().int(),
  /** Whose session fetched it: another person signing in clears it. */
  staffId: z.string().min(1),
  /** When the server last confirmed it (epoch ms): the age is counted from here. */
  savedAt: z.number().int().nonnegative(),
  /** The rev of the setting row it came from: only a newer notice makes it stale. */
  rev: z.number().int().nonnegative(),
  /** A change notice arrived and the copy has not been confirmed since. */
  stale: z.boolean(),
  target: promptpaySettingsSchema,
});
export type SavedPromptpay = z.infer<typeof savedSchema>;

/** The saved record if it can be trusted, else null (damaged, or from another schema). */
export function readSavedPromptpay(raw: unknown): SavedPromptpay | null {
  const parsed = savedSchema.safeParse(raw);
  if (!parsed.success || parsed.data.v !== PROMPTPAY_CACHE_SCHEMA) return null;
  return parsed.data;
}

export type OfflineQrRefusal = 'none' | 'stale' | 'tooOld' | 'badAmount';

export type OfflineQr =
  | {
      ok: true;
      /** The EMVCo text to draw. It holds the ID: draw it, never store, log or label it. */
      payload: string;
      /** The last four characters of the saved ID, for the "check the bank app" banner. */
      last4: string;
      savedAt: number;
    }
  | { ok: false; reason: OfflineQrRefusal };

/** Is the saved ID still allowed to be used for a QR at `nowMs`? */
export function savedIdRefusal(
  saved: SavedPromptpay | null,
  nowMs: number,
): Exclude<OfflineQrRefusal, 'badAmount'> | null {
  if (saved === null) return 'none';
  if (saved.stale) return 'stale';
  const age = nowMs - saved.savedAt;
  if (age > OFFLINE_QR_MAX_AGE_MS || age < -CLOCK_BACK_TOLERANCE_MS) return 'tooOld';
  return null;
}

/** The QR for `amountSatang`, or why none may be shown. */
export function offlineQr(
  saved: SavedPromptpay | null,
  nowMs: number,
  amountSatang: number | null,
): OfflineQr {
  const refusal = savedIdRefusal(saved, nowMs);
  if (refusal !== null || saved === null) return { ok: false, reason: refusal ?? 'none' };
  if (amountSatang === null || !Number.isSafeInteger(amountSatang) || amountSatang <= 0) {
    return { ok: false, reason: 'badAmount' };
  }
  try {
    return {
      ok: true,
      payload: promptpayPayload(saved.target, satang(amountSatang)),
      last4: saved.target.idValue.slice(-4),
      savedAt: saved.savedAt,
    };
  } catch (error) {
    // Too large, or an ID the payload cannot hold. Only the reason leaves, never the error text.
    if (error instanceof RangeError) return { ok: false, reason: 'badAmount' };
    throw error;
  }
}
