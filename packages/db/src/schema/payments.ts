/**
 * Schema: the co-pay scheme, payments (with every slip column) and partial refunds.
 */
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SLIP_CHECKS,
  SLIP_RECIPIENT_CHECKS,
  SLIP_VERIFY_VERDICTS,
} from '@sds/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money, oneOf, sync, ts } from './columns.ts';
import { orders } from './orders.ts';
import { staff } from './people.ts';

// ---------- Payments ----------

export const govCopaySchemes = pgTable(
  'gov_copay_schemes',
  {
    id: id(),
    code: text('code').notNull().unique(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    govShareBp: integer('gov_share_bp').notNull(),
    govDailyCapSatang: money('gov_daily_cap_satang'),
    govTotalCapSatang: money('gov_total_cap_satang'),
    activeFrom: date('active_from', { mode: 'string' }).notNull(),
    activeTo: date('active_to', { mode: 'string' }).notNull(),
    /** Minutes from local midnight, e.g. 06:00–23:00 → 360–1380. */
    activeFromMinute: integer('active_from_minute').notNull().default(0),
    activeToMinute: integer('active_to_minute').notNull().default(1440),
    channels: text('channels').array().notNull().default(sql`'{storefront}'::text[]`),
    settlementNote: text('settlement_note'),
    enabled: boolean('enabled').notNull().default(false),
    ...sync,
  },
  (t) => [
    index('gov_copay_schemes_rev_idx').on(t.rev),
    check('gov_copay_schemes_share', sql`gov_share_bp between 0 and 10000`),
    check('gov_copay_schemes_dates', sql`active_from <= active_to`),
    check(
      'gov_copay_schemes_minutes',
      sql`0 <= active_from_minute and active_from_minute < active_to_minute and active_to_minute <= 1440`,
    ),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    method: text('method').notNull(),
    status: text('status').notNull().default('pending'),
    amountSatang: money('amount_satang').notNull(),
    tenderedSatang: money('tendered_satang'),
    changeSatang: money('change_satang'),
    promptpayTargetMasked: text('promptpay_target_masked'),
    qrPayload: text('qr_payload'),
    schemeId: uuid('scheme_id').references(() => govCopaySchemes.id),
    estGovShareSatang: money('est_gov_share_satang'),
    estCustomerShareSatang: money('est_customer_share_satang'),
    slipImageKey: text('slip_image_key'),
    slipRef: text('slip_ref'),
    /**
     * What the automatic reading of the slip found (D-26): a hint for staff, never a confirmation.
     * The amount read off the slip (null while pending or unreadable) and where the check stands
     * (null: no slip, or the check is off). The OCR text itself is never stored.
     */
    slipAmountSatang: money('slip_amount_satang'),
    slipCheck: text('slip_check'),
    /**
     * Duplicate-slip hint (D-26): SHA-256 (hex) of the picture's bytes, and of the bank reference
     * read from it (null when none was found). Only the hashes are kept, never the text or the
     * reference; cleared with the slip.
     */
    slipImageHash: text('slip_image_hash'),
    slipRefHash: text('slip_ref_hash'),
    /**
     * SHA-256 (hex) of `sendingBank:transRef` read from the slip's small QR (D-26), or null when no
     * readable QR was found. Not comparable with `slipRefHash` (another input). Cleared with the slip.
     */
    slipQrHash: text('slip_qr_hash'),
    /**
     * Whether the receiver printed on the slip looks like the shop's PromptPay ID (D-26): `match`,
     * `mismatch` or `unknown`; null when not read (no ID set, or the reading is off). Only the word is
     * kept, never the text or any digits. A hint for staff. Cleared with the slip.
     */
    slipRecipientCheck: text('slip_recipient_check'),
    /**
     * The bank check of the slip by Slip2Go (D-27): the verdict (null: no slip, or the verifier is
     * off), Slip2Go's 6-digit result code and its `referenceId` (support only), how many attempts
     * were made (transient failures retry up to 3) and when the verdict landed. Never names,
     * accounts, the QR text or the raw answer. A new slip resets all of it; cleared with the slip.
     */
    slipVerify: text('slip_verify'),
    slipVerifyCode: text('slip_verify_code'),
    slipVerifyRef: text('slip_verify_ref'),
    slipVerifyAttempts: smallint('slip_verify_attempts').notNull().default(0),
    slipVerifiedAt: ts('slip_verified_at'),
    /** When this picture was uploaded: the start of the not-found grace window (banks are slow). Cleared with the slip. */
    slipUploadedAt: ts('slip_uploaded_at'),
    /**
     * Bank-check cycles this payment has started (a first upload, a re-send of a final "not found",
     * or a different picture), capped lifetime so one order cannot drain the Slip2Go cap. Never reset
     * by a new picture. Cleared with the slip purge. Never in sync or realtime.
     */
    slipVerifyCycles: smallint('slip_verify_cycles').notNull().default(0),
    /** Calls of the current picture that staff asked for (inside `slip_verify_attempts`); reset with it. Never in sync. */
    slipStaffCalls: smallint('slip_staff_calls').notNull().default(0),
    /**
     * Slip cooldown (owner decision): how many finished bank checks of this payment were a
     * definitive failure (wrong receiver, amount or date, or not found), and when the last was.
     * Kept across new slips; staff rechecks do not count. Never in sync or realtime.
     */
    slipInvalidCount: smallint('slip_invalid_count').notNull().default(0),
    slipInvalidAt: ts('slip_invalid_at'),
    /**
     * Slip block: the bank-check service said "fake slip" (code 200500). The ORDER takes no more
     * slips while any of its payments has this set; "โอนแล้ว" still works and staff verify by hand.
     * The owner lifts it: `slip_blocked_at` goes back to null and `slip_reviewed_at` records when.
     * Staff only, REST only.
     */
    slipBlockedAt: ts('slip_blocked_at'),
    slipBlockReason: text('slip_block_reason'),
    slipReviewedAt: ts('slip_reviewed_at'),
    referenceNote: text('reference_note'),
    claimedAt: ts('claimed_at'),
    confirmedByStaffId: uuid('confirmed_by_staff_id').references(() => staff.id),
    confirmedAt: ts('confirmed_at'),
    /** Set only when the owner took over a device's outbox: the cashier who took this cash. */
    originalStaffId: uuid('original_staff_id').references(() => staff.id),
    voidReason: text('void_reason'),
    /**
     * Confirmed by the server itself after a valid bank check of the slip (D-27): then
     * `confirmed_by_staff_id` stays null. Staff void and refund such a payment as any other. Never
     * in sync or realtime; staff see it on `GET /v1/orders/:id/payments`.
     */
    autoConfirmed: boolean('auto_confirmed').notNull().default(false),
    clientRequestId: uuid('client_request_id').notNull(),
    /** Fingerprint of the request that made this payment; null on rows saved before it existed. */
    requestHash: text('request_hash'),
    ...sync,
  },
  (t) => [
    uniqueIndex('payments_client_request_id_key').on(t.clientRequestId),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_confirmed_by_staff_id_idx').on(t.confirmedByStaffId),
    index('payments_original_staff_id_idx').on(t.originalStaffId),
    index('payments_scheme_id_idx').on(t.schemeId),
    index('payments_open_status_idx').on(t.status).where(sql`status in ('pending', 'claimed')`),
    // DB backstop for "one open payment per order" (the order row lock is the first line).
    uniqueIndex('payments_one_open_per_order')
      .on(t.orderId)
      .where(sql`status in ('pending', 'claimed')`),
    index('payments_rev_idx').on(t.rev),
    index('payments_slip_image_hash_idx').on(t.slipImageHash),
    index('payments_slip_ref_hash_idx').on(t.slipRefHash),
    index('payments_slip_qr_hash_idx').on(t.slipQrHash),
    check('payments_method', oneOf('method', PAYMENT_METHODS)),
    check('payments_status', oneOf('status', PAYMENT_STATUSES)),
    check(
      'payments_slip_recipient_check',
      sql`slip_recipient_check is null or ${oneOf('slip_recipient_check', SLIP_RECIPIENT_CHECKS)}`,
    ),
    check('payments_slip_check', sql`slip_check is null or ${oneOf('slip_check', SLIP_CHECKS)}`),
    check(
      'payments_slip_verify',
      sql`slip_verify is null or ${oneOf('slip_verify', SLIP_VERIFY_VERDICTS)}`,
    ),
    check('payments_amount_nonneg', sql`amount_satang >= 0`),
    check(
      'payments_cash_change',
      sql`tendered_satang is null or (tendered_satang >= amount_satang and change_satang = tendered_satang - amount_satang)`,
    ),
    // Rule 2: a confirmed payment names the staff member who confirmed it, or is marked as
    // confirmed by the server itself after a valid bank check (D-27).
    check(
      'payments_confirmed_by_staff',
      sql`status not in ('confirmed', 'voided', 'refunded') or (confirmed_at is not null and (confirmed_by_staff_id is not null or auto_confirmed))`,
    ),
  ],
);

/**
 * A partial refund of a confirmed payment (owner correction of a paid order, D-25). Append-only:
 * the payment stays `confirmed` and what has really been paid is its amount minus its refunds. Not
 * a synced table (no rev): devices read it with `GET /v1/orders/:id/payments`. Rows are never
 * changed or deleted (a trigger forbids it, like the other financial tables).
 */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    amountSatang: money('amount_satang').notNull(),
    /** How the money went back: `cash` or `promptpay`. */
    method: text('method').notNull(),
    referenceNote: text('reference_note'),
    reason: text('reason').notNull(),
    refundedByStaffId: uuid('refunded_by_staff_id')
      .notNull()
      .references(() => staff.id),
    refundedAt: ts('refunded_at').notNull().defaultNow(),
  },
  (t) => [
    index('payment_refunds_order_id_idx').on(t.orderId),
    index('payment_refunds_payment_id_idx').on(t.paymentId),
    index('payment_refunds_refunded_by_staff_id_idx').on(t.refundedByStaffId),
    check('payment_refunds_amount_positive', sql`amount_satang > 0`),
    check('payment_refunds_method', oneOf('method', ['cash', 'promptpay'])),
  ],
);
