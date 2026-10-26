/**
 * Slip2Go slip verification (D-27), the pure part. Nothing here talks to the network.
 *
 * Slip2Go checks a transfer slip against the bank's records and answers with a `code`. We branch on
 * the code, never on the HTTP status (the QR-text call answers 200, the image call 201). The
 * answer is a hint for staff; the server auto-confirms only under the conditions of D-27.
 *
 * Money (CLAUDE.md rule 1): Slip2Go speaks baht (`"85.50"` out, `85.5` as a JSON number back).
 * Both directions go through integer string maths, never `* 100`, `toFixed` or other float steps.
 */
import { z } from 'zod';
import { type Satang, satang } from './money.ts';
import { normaliseSlipRef } from './slip-ref.ts';

/** Where the bank check of a slip stands. Null on a payment without a slip (or with the verifier off). */
export const SLIP_VERIFY_VERDICTS = [
  'pending',
  'valid',
  'amount_mismatch',
  'receiver_mismatch',
  'date_mismatch',
  'not_found',
  'fraud',
  'unchecked',
] as const;
export type SlipVerifyVerdict = (typeof SLIP_VERIFY_VERDICTS)[number];

/** A verdict that Slip2Go (or our fallback) has given: everything except `pending`. */
export type SlipVerifyResult = Exclude<SlipVerifyVerdict, 'pending'>;

/** Satang to the string Slip2Go wants for `checkAmount.amount`: always two decimals ("85.50"). */
export function satangToSlip2goAmount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`satang must be a non-negative safe integer, got ${value}`);
  }
  const whole = Math.trunc(value / 100);
  const fraction = value - whole * 100;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

const BAHT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Slip2Go's `data.amount` (a JSON number in baht, e.g. 85.5) or a baht string to satang, or null
 * when it is not a clean amount: NaN, negative, more than two decimals, exponent notation, or a
 * float artefact such as 0.1 + 0.2. A number is read through its shortest decimal string.
 */
export function slip2goAmountToSatang(value: number | string): Satang | null {
  const text = typeof value === 'number' ? String(value) : value;
  const match = BAHT.exec(text);
  if (!match?.[1]) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const total = whole * 100 + fraction;
  return Number.isSafeInteger(total) ? satang(total) : null;
}

/** One entry of `checkReceiver`: a match on any one entry passes. */
export interface Slip2goReceiver {
  accountType: string;
  accountNumber: string;
}

const PROMPTPAY_TYPE_BY_LENGTH: Record<number, string> = { 10: '02001', 13: '02003', 15: '02004' };

/**
 * The receivers to send, built from the shop's settings at check time (never hardcoded). The
 * PromptPay ID is typed by its shape: 10-digit phone `02001`, 13-digit ID `02003`, 15-digit
 * e-wallet `02004` (only `02001` is proven live). A bank account counts only with its bank code
 * (`01` + code). An empty list means "nothing to check against": the caller must not call Slip2Go,
 * because a call without a receiver would let a transfer to anyone pass.
 */
export function slip2goReceivers(
  promptpayId: string | null,
  account: { bankCode: string; accountNumber: string } | null,
): Slip2goReceiver[] {
  const out: Slip2goReceiver[] = [];
  const digits = promptpayId?.replace(/[\s-]/g, '') ?? '';
  const accountType = /^\d+$/.test(digits) ? PROMPTPAY_TYPE_BY_LENGTH[digits.length] : undefined;
  if (accountType) out.push({ accountType, accountNumber: digits });
  if (account && /^\d{3}$/.test(account.bankCode) && /^\d{10,15}$/.test(account.accountNumber)) {
    out.push({ accountType: `01${account.bankCode}`, accountNumber: account.accountNumber });
  }
  return out;
}

/**
 * The receiver types for which an automatic confirmation is allowed (D-27): only the PromptPay
 * phone number (`02001`, 10 digits), the one form proven live. The 13-digit ID (`02003`), the
 * 15-digit e-wallet (`02004`) and bank accounts still get the call and the verdict, but staff tick.
 * This list grows only after a live probe shows that Slip2Go matches that form correctly.
 */
export const SLIP2GO_AUTOCONFIRM_ACCOUNT_TYPES: readonly string[] = ['02001'];

/**
 * Whether every receiver sent to Slip2Go is one that may be auto-confirmed. "Every", not "any":
 * Slip2Go passes on a match with any one entry and does not say which, so a single entry outside
 * the list could be the one that matched. Empty is never allowed.
 */
export function slip2goAutoConfirmReceivers(receivers: readonly Slip2goReceiver[]): boolean {
  return (
    receivers.length > 0 &&
    receivers.every((r) => SLIP2GO_AUTOCONFIRM_ACCOUNT_TYPES.includes(r.accountType))
  );
}

/**
 * The duplicate key of a transfer as text: `<3-digit sending bank>:<reference>`, the reference
 * normalised (upper case, no hyphens). The local QR decode and Slip2Go's answer both go through it,
 * so the same transfer gives the same key from either side. Null when the bank is not 3 digits or
 * the reference does not look like one.
 */
export function slipQrKeyText(bank: string, ref: string): string | null {
  if (!/^\d{3}$/.test(bank)) return null;
  const normalised = normaliseSlipRef(ref);
  return normalised ? `${bank}:${normalised}` : null;
}

export interface Slip2goVerdict {
  verdict: SlipVerifyResult;
  /** Try again later (bank error, rate limit, server error). */
  retry: boolean;
  /** The shop's Slip2Go account is the problem (expired, no tokens, IP not allowed): tell the owner. */
  alert: boolean;
}

const verdictOf = (
  verdict: SlipVerifyResult,
  flags: Partial<Omit<Slip2goVerdict, 'verdict'>> = {},
): Slip2goVerdict => ({ verdict, retry: false, alert: false, ...flags });

/**
 * Slip2Go's result code to our verdict. Only `200200` (every condition passed) is `valid`, and
 * even then a local amount re-check that says `false` wins. `200000` (found, nothing checked)
 * fails closed. Unknown codes are `unchecked`.
 */
export function slip2goVerdict(code: string, localAmountOk: boolean | null): Slip2goVerdict {
  switch (code) {
    case '200200':
      return verdictOf(localAmountOk === false ? 'amount_mismatch' : 'valid');
    case '200401':
      return verdictOf('receiver_mismatch');
    case '200402':
      return verdictOf('amount_mismatch');
    case '200403':
      return verdictOf('date_mismatch');
    case '200404':
      return verdictOf('not_found');
    case '200500':
      return verdictOf('fraud');
    case '200502':
    case '429000':
      return verdictOf('unchecked', { retry: true });
    case '401001':
    case '401002':
    case '401003':
    case '401004':
    case '401005':
    case '401006':
    case '401007':
      return verdictOf('unchecked', { alert: true });
    default:
      return verdictOf('unchecked', { retry: /^5\d{5}$/.test(code) });
  }
}

/** Whether the transfer time Slip2Go reports is at or after the order's `notBefore` (PAY-01). */
export type SlipTransferDateCheck = 'ok' | 'too_old' | 'unknown';

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const SLIP_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLIP_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Milliseconds since the epoch of a calendar date and wall time read as UTC, or null when it does not exist. */
function wallClockUtc(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
): number | null {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d
    ? at
    : null;
}

/**
 * Checks Slip2Go's `data.dateTime` against `notBefore` (the same instant sent as `checkDate`), on our
 * side, so that a `200200` never auto-confirms on Slip2Go's date check alone (PAY-01).
 *
 * Rule (fail closed): the text is turned into the RANGE of instants it can mean, at the granularity
 * it gives, and
 * - `ok` only when the EARLIEST of them is at or after `notBefore` (the boundary passes);
 * - `too_old` only when the LATEST of them is before `notBefore`;
 * - `unknown` otherwise: missing, unparseable, an impossible date, or a range that straddles it.
 *
 * Accepted forms (live: ISO with `+07:00`, docs/plans/slip2go-integration.md section 11):
 * `YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z` or `±HH:MM` / `±HHMM` (a space may replace `T`); without a
 * zone it is read both as Asia/Bangkok and as UTC (the range covers both); a bare `YYYY-MM-DD` is a
 * Bangkok calendar day. Minutes only means the whole minute; digits past milliseconds are dropped
 * (the range then spans that millisecond). Pure: no clock, no locale.
 */
export function slip2goTransferDateCheck(
  dateTime: string | null | undefined,
  notBefore: Date,
): SlipTransferDateCheck {
  const limit = notBefore.getTime();
  if (!dateTime || Number.isNaN(limit)) return 'unknown';
  let earliest: number;
  let latest: number;
  const dateOnly = SLIP_DATE_ONLY.exec(dateTime);
  const full = dateOnly ? null : SLIP_DATE_TIME.exec(dateTime);
  if (dateOnly) {
    const day = wallClockUtc(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    if (day === null) return 'unknown';
    earliest = day - BANGKOK_OFFSET_MS;
    latest = earliest + 86_400_000 - 1;
  } else if (full) {
    const [, y, mo, d, h, mi, s, frac, zone] = full;
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
    const wall = wallClockUtc(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      s === undefined ? 0 : Number(s),
      ms,
    );
    if (wall === null) return 'unknown';
    // How much later the true instant can be than the text, at the precision given.
    const unit =
      s === undefined
        ? 60_000
        : frac === undefined
          ? 1000
          : frac.length >= 3
            ? 1
            : 10 ** (3 - frac.length);
    if (zone === undefined) {
      earliest = wall - BANGKOK_OFFSET_MS;
      latest = wall + unit - 1;
    } else {
      let offsetMs = 0;
      if (zone !== 'Z') {
        const digits = zone.slice(1).replace(':', '');
        const oh = Number(digits.slice(0, 2));
        const om = Number(digits.slice(2));
        if (oh > 14 || om > 59) return 'unknown';
        offsetMs = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
      }
      earliest = wall - offsetMs;
      latest = earliest + unit - 1;
    }
  } else {
    return 'unknown';
  }
  if (earliest >= limit) return 'ok';
  if (latest < limit) return 'too_old';
  return 'unknown';
}

/**
 * The part of Slip2Go's answer we keep. Everything else (names, account numbers, receiver and
 * sender details) is dropped by the parse and never reaches memory beyond it.
 */
export const slip2goResponseSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
  data: z
    .object({
      referenceId: z.string().optional(),
      transRef: z.string().optional(),
      amount: z.union([z.number(), z.string()]).optional(),
      dateTime: z.string().optional(),
      sender: z.object({ bank: z.object({ id: z.string().optional() }).optional() }).optional(),
    })
    .optional(),
});
export type Slip2goResponse = z.infer<typeof slip2goResponseSchema>;

/**
 * Banks can take a while (Bangkok Bank: 10 s or more) before Slip2Go can find a transfer. A "not
 * found" (200404) for a slip uploaded less than this many seconds ago is not final: the check is
 * tried again (within its own call budget, below) and only the last answer counts.
 */
export const SLIP_NOT_FOUND_GRACE_SECONDS = 300;

/**
 * Calls in all that one picture may have while its answer is "not found" inside the window. This
 * budget is separate from the 3 attempts a slip gets when the service or bank errors out. Every
 * not-found call costs a Slip2Go token, so the budget is small and the first call is held late
 * (below) instead.
 */
export const SLIP_NOT_FOUND_GRACE_MAX_CALLS = 4;

/**
 * How long after the upload the first bank call waits by default (production). Most banks know a
 * transfer within this time; a bank that is known to be slower has its own entry below.
 */
export const SLIP_FIRST_CALL_DELAY_MS = 10_000;

/**
 * Per sending bank (3-digit code from the slip's own QR) first-call hold, for banks that were seen
 * to publish a transfer late: Bangkok Bank (002) was unknown to Slip2Go until about 67 s after the
 * upload. Used only when the local QR decode tells the bank; an unreadable QR gets the default.
 */
export const SLIP_FIRST_CALL_DELAY_BY_BANK_MS: Readonly<Record<string, number>> = {
  '002': 50_000,
};

/**
 * Waits between the calls of the not-found grace budget: a timer fires the next call this long
 * after the END of the previous call. With the default hold the calls start about 10, 30, 60 and
 * 120 s after the upload (50, 70, 100 and 160 s for bank 002), the last well inside the window. One
 * entry fewer than SLIP_NOT_FOUND_GRACE_MAX_CALLS. The minute sweep is the fallback after a restart.
 */
export const SLIP_GRACE_RETRY_DELAYS_MS: readonly number[] = [20_000, 30_000, 60_000];

/** A re-send of the same picture is a fresh check only this many seconds after the last call. */
export const SLIP_RESEND_MIN_GAP_SECONDS = 60;

/**
 * Lifetime limit per payment: a re-send (or a different picture) opens a new check cycle at most
 * this many times after the first. One payment therefore has at most `1 + this` = 3 cycles, however
 * the customer alternates pictures; it keeps one order from draining the shared daily call cap.
 */
export const SLIP_RESEND_RECHECKS_MAX = 2;

/** Whether a payment that has started `cycles` bank-check cycles may start another. */
export const slipCycleAvailable = (cycles: number): boolean =>
  cycles < 1 + SLIP_RESEND_RECHECKS_MAX;

/**
 * Whether the customer sending the SAME picture again starts a new check: only after a final
 * `not_found` or `unchecked` (never valid, fraud, a block, a reviewed slip, or any mismatch, and not
 * while pending), only when the last bank call for it was at least a minute ago, and only while the
 * payment still has a cycle left (`SLIP_RESEND_RECHECKS_MAX`).
 */
export const slipResendRechecks = (
  current: {
    verdict: SlipVerifyVerdict | null;
    verifiedAt: Date | null;
    blockedAt: Date | null;
    reviewedAt: Date | null;
    /** Check cycles this payment has started so far, the first included. */
    cycles: number;
  },
  now: Date,
): boolean =>
  slipCycleAvailable(current.cycles) &&
  (current.verdict === 'not_found' || current.verdict === 'unchecked') &&
  current.verifiedAt !== null &&
  current.blockedAt === null &&
  current.reviewedAt === null &&
  now.getTime() - current.verifiedAt.getTime() >= SLIP_RESEND_MIN_GAP_SECONDS * 1000;

/** Whether a slip uploaded at `uploadedAt` is still inside the not-found grace window at `now`. */
export const inSlipNotFoundGrace = (
  uploadedAt: Date | null,
  now: Date,
  graceSeconds: number = SLIP_NOT_FOUND_GRACE_SECONDS,
): boolean => uploadedAt !== null && now.getTime() - uploadedAt.getTime() < graceSeconds * 1000;

// ---------- Cooldown and fraud (owner decision) ----------

/** The verdicts that count as a definitive "this slip is not good" for the cooldown. */
export const SLIP_INVALID_VERDICTS: readonly SlipVerifyResult[] = [
  'amount_mismatch',
  'receiver_mismatch',
  'date_mismatch',
  'not_found',
];

/** Whether a finished bank check counts toward the cooldown. `fraud` blocks instead; the rest never count. */
export const isInvalidSlipVerdict = (verdict: SlipVerifyVerdict): boolean =>
  (SLIP_INVALID_VERDICTS as readonly string[]).includes(verdict);

/** A payment may have this many invalid slip results before the next upload has to wait. */
export const SLIP_INVALID_FREE_TRIES = 3;
/** How long after the LAST invalid result the next upload waits, once the free tries are used. */
export const SLIP_COOLDOWN_SECONDS = 300;

/**
 * Seconds until the next slip upload for this payment is allowed; 0 when it is allowed now.
 * Refused only when the payment has `SLIP_INVALID_FREE_TRIES` or more invalid results and `now` is
 * before the last of them plus `SLIP_COOLDOWN_SECONDS` (at exactly that moment it is allowed).
 */
export function slipCooldownSeconds(
  slip: { invalidCount: number; lastInvalidAt: Date | null },
  now: Date,
): number {
  if (slip.invalidCount < SLIP_INVALID_FREE_TRIES || slip.lastInvalidAt === null) return 0;
  const left = slip.lastInvalidAt.getTime() + SLIP_COOLDOWN_SECONDS * 1000 - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
