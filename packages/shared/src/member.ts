/**
 * The member profile (owner, 2026-10-11): optional details a customer may give so staff can tell
 * who an order is for. None is required to order. Personal data (PDPA): covered by the privacy
 * notice the customer already acknowledges, erased with the customer, never logged.
 *
 * Request side: a field left out keeps the saved value; an empty string clears it. Pure: no I/O.
 */
import { z } from 'zod';

export const MEMBER_FULL_NAME_MAX = 100;
export const MEMBER_NICKNAME_MAX = 40;
export const MEMBER_BUILDING_MAX = 60;

/** Control and format characters (tabs, newlines, zero-width marks) become spaces; runs collapse. */
export function cleanText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A Thai phone number as digits starting with 0: spaces, dots, hyphens and brackets are dropped and
 * a +66 or 66 prefix becomes 0. Mobile: 06, 08, 09 plus 8 digits. Landline: 02, 03, 04, 05, 07
 * plus 7 digits. Returns null when it is neither.
 */
export function normalizeThaiPhone(value: string): string | null {
  let digits = cleanText(value).replace(/[\s.\-()]/gu, '');
  if (digits.startsWith('+66')) digits = `0${digits.slice(3)}`;
  else if (/^66\d{8,9}$/u.test(digits)) digits = `0${digits.slice(2)}`;
  return /^0(?:[2-57]\d{7}|[689]\d{8})$/u.test(digits) ? digits : null;
}

/** A text field: cleaned, length-checked after cleaning, empty means "clear" (null). */
const text = (max: number) =>
  z
    .string()
    .max(500)
    .transform(cleanText)
    .pipe(z.string().max(max))
    .transform((v) => (v === '' ? null : v));

const phone = z
  .string()
  .max(40)
  .transform((raw, ctx): string | null => {
    if (cleanText(raw) === '') return null;
    const normalized = normalizeThaiPhone(raw);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'not a Thai phone number' });
      return z.NEVER;
    }
    return normalized;
  });

/** What the checkout form sends. Strict: an unknown field is a 400, never silently dropped. */
export const memberInputSchema = z.strictObject({
  fullName: text(MEMBER_FULL_NAME_MAX).optional(),
  nickname: text(MEMBER_NICKNAME_MAX).optional(),
  building: text(MEMBER_BUILDING_MAX).optional(),
  phone: phone.optional(),
});
export type MemberInput = z.infer<typeof memberInputSchema>;

/** The saved profile, or the snapshot on an order: every field present, null when not given. */
export const memberProfileSchema = z.object({
  fullName: z.string().nullable(),
  nickname: z.string().nullable(),
  building: z.string().nullable(),
  phone: z.string().nullable(),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;

export const NO_MEMBER_PROFILE: MemberProfile = {
  fullName: null,
  nickname: null,
  building: null,
  phone: null,
};

/** The saved profile with the form applied: a field left out keeps its value, null clears it. */
export function mergeMember(saved: MemberProfile, input: MemberInput): MemberProfile {
  return {
    fullName: input.fullName === undefined ? saved.fullName : input.fullName,
    nickname: input.nickname === undefined ? saved.nickname : input.nickname,
    building: input.building === undefined ? saved.building : input.building,
    phone: input.phone === undefined ? saved.phone : input.phone,
  };
}
