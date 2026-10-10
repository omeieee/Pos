/**
 * The optional member form of the checkout (owner, 2026-10-11). Nothing here is required to order.
 * The server is the authority (it cleans, validates and saves); this only saves a round trip and
 * decides which fields to send: just the ones the customer filled in or changed.
 *
 * The limits and the phone rule mirror `packages/shared/src/member.ts`. They are copied, not
 * imported, because that file pulls the schema library into the customer app's bundle; the test
 * compares them with the shared ones so they cannot drift.
 */
import type { MemberInput, MemberProfile } from '@sds/shared';

export const MEMBER_LIMITS = { fullName: 100, nickname: 40, building: 60 } as const;

export interface MemberForm {
  fullName: string;
  nickname: string;
  building: string;
  phone: string;
}

export type MemberField = keyof MemberForm;

export const EMPTY_MEMBER_FORM: MemberForm = {
  fullName: '',
  nickname: '',
  building: '',
  phone: '',
};

const FIELDS: readonly MemberField[] = ['fullName', 'nickname', 'building', 'phone'];

/** The form filled with the saved profile (an older server sends none: all empty). */
export function memberFormOf(saved: MemberProfile | undefined): MemberForm {
  return {
    fullName: saved?.fullName ?? '',
    nickname: saved?.nickname ?? '',
    building: saved?.building ?? '',
    phone: saved?.phone ?? '',
  };
}

const clean = (value: string): string =>
  value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

/** A Thai phone number as the server accepts it (06/08/09 mobile, 02-05/07 landline, +66 ok). */
export function isThaiPhone(value: string): boolean {
  let digits = clean(value).replace(/[\s.\-()]/gu, '');
  if (digits.startsWith('+66')) digits = `0${digits.slice(3)}`;
  else if (/^66\d{8,9}$/u.test(digits)) digits = `0${digits.slice(2)}`;
  return /^0(?:[2-57]\d{7}|[689]\d{8})$/u.test(digits);
}

/** The fields that would be refused: a phone that is not a Thai number, or a text that is too long. */
export function memberProblems(form: MemberForm): MemberField[] {
  const problems: MemberField[] = [];
  for (const field of ['fullName', 'nickname', 'building'] as const) {
    if (clean(form[field]).length > MEMBER_LIMITS[field]) problems.push(field);
  }
  if (clean(form.phone) !== '' && !isThaiPhone(form.phone)) problems.push('phone');
  return problems;
}

/**
 * What to send: only the fields whose cleaned text differs from the saved one. A field the
 * customer emptied is sent as "" (the server clears it); an untouched field is left out (the
 * server keeps it). `undefined` when nothing changed, so the order carries no member part at all.
 * The phone is compared as typed; a differently formatted but equal number is sent and the server
 * normalises it to the same value.
 */
export function memberInput(
  form: MemberForm,
  saved: MemberProfile | undefined,
): MemberInput | undefined {
  const before = memberFormOf(saved);
  const out: MemberInput = {};
  for (const field of FIELDS) {
    const now = clean(form[field]);
    if (now !== clean(before[field])) out[field] = now;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
