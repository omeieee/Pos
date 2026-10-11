/**
 * Queries for payments. Only packages/db imports the ORM, so apps/api calls these inside its own
 * transaction. Rules (state machine, who may confirm, step-up, what the order's payment status is)
 * stay in apps/api and packages/shared.
 *
 * Lock order, always: the order row first (`ordersRepo.lockOrderById`), then payment rows. Every
 * payment write takes the order lock, so two requests for one order queue up on it and cannot both
 * see "no open payment". The same order everywhere also rules out a deadlock.
 */
import type {
  PaymentMethod,
  PaymentStatus,
  SlipCheck,
  SlipRecipientCheck,
  SlipVerifyVerdict,
} from '@sds/shared';
import { and, asc, count, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { orders, paymentRefunds, payments, slipVerifyDaily } from './schema.ts';

export type PaymentRow = typeof payments.$inferSelect;

/** How many payments of `method` are open (pending or claimed) right now. */
export async function countOpenByMethod(db: Db, method: PaymentMethod): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.method, method), inArray(payments.status, ['pending', 'claimed'])));
  return row?.n ?? 0;
}

/** The partial unique index that allows one open (pending or claimed) payment per order. */
export const OPEN_PAYMENT_INDEX = 'payments_one_open_per_order';

/**
 * True when `error` is a unique violation of {@link OPEN_PAYMENT_INDEX}: a second open payment for
 * an order that got past the order lock. Drizzle wraps the driver error as `cause`; PGlite names
 * the index `constraint`, postgres-js `constraint_name`, and the server message names it too.
 */
export function isOpenPaymentConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth += 1) {
    const e = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (e.code === '23505') {
      const name = e.constraint ?? e.constraint_name;
      if (name === OPEN_PAYMENT_INDEX) return true;
      if (typeof e.message === 'string' && e.message.includes(`"${OPEN_PAYMENT_INDEX}"`)) {
        return true;
      }
    }
    current = e.cause;
  }
  return false;
}

/**
 * A new payment. There is no qr_payload here on purpose: the payload holds the PromptPay ID in
 * clear, so it is rebuilt from the current setting whenever the QR is shown and never stored
 * (the column stays for now; dropping it is a later contract migration).
 */
export interface NewPayment {
  orderId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountSatang: number;
  tenderedSatang?: number | null;
  changeSatang?: number | null;
  promptpayTargetMasked?: string | null;
  schemeId?: string | null;
  estGovShareSatang?: number | null;
  estCustomerShareSatang?: number | null;
  referenceNote?: string | null;
  confirmedByStaffId?: string | null;
  confirmedAt?: Date | null;
  /** Owner outbox take-over only: the cashier who really took this cash. */
  originalStaffId?: string | null;
  clientRequestId: string;
  requestHash: string;
}

/** What a move may write; everything else on a payment is fixed when it is made. */
export interface PaymentPatch {
  status?: PaymentStatus;
  claimedAt?: Date;
  confirmedByStaffId?: string;
  confirmedAt?: Date;
  referenceNote?: string;
  voidReason?: string;
  /** Set when a co-pay request made while the scheme was off is confirmed. */
  schemeId?: string;
  estGovShareSatang?: number;
  estCustomerShareSatang?: number;
  /** The stored slip image (a random key); null clears it. */
  slipImageKey?: string | null;
  /** What the automatic reading of the slip found (D-26); a new slip resets both. */
  slipCheck?: SlipCheck | null;
  slipAmountSatang?: number | null;
  /** SHA-256 (hex) of the slip picture and of the bank reference read from it (D-26). */
  slipImageHash?: string | null;
  slipRefHash?: string | null;
  slipQrHash?: string | null;
  /** Whether the receiver on the slip looks like the shop's PromptPay ID (D-26); a new slip resets it. */
  slipRecipientCheck?: SlipRecipientCheck | null;
  /** The bank check by Slip2Go (D-27): verdict, result code, reference id, attempts, when. A new slip resets them. */
  slipVerify?: SlipVerifyVerdict | null;
  slipVerifyCode?: string | null;
  slipVerifyRef?: string | null;
  slipVerifyAttempts?: number;
  slipVerifiedAt?: Date | null;
  /** Confirmed by the server itself after a valid bank check (D-27), not by a staff member. */
  autoConfirmed?: boolean;
}

export async function findPaymentById(db: Db, id: string): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return row;
}

/** Locks the payment row until the transaction ends. Take the order lock first. */
export async function lockPaymentById(db: Db, id: string): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.id, id)).for('update').limit(1);
  return row;
}

export async function findPaymentByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

/** Every payment of an order, oldest first. */
export async function listPaymentsForOrder(db: Db, orderId: string): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(asc(payments.rev), asc(payments.id));
}

/**
 * Inserts the payment, or returns undefined when another request with the same client request id
 * got there first (the unique index decides, even for two requests at the same instant).
 */
export async function insertPayment(db: Db, payment: NewPayment): Promise<PaymentRow | undefined> {
  const [row] = await db
    .insert(payments)
    .values(payment)
    .onConflictDoNothing({ target: payments.clientRequestId })
    .returning();
  return row;
}

/**
 * One UPDATE guarded by the version the caller saw. No row back means the payment changed since;
 * the caller reads it again to tell. The sync trigger bumps version and rev.
 */
export async function updatePaymentIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: PaymentPatch,
): Promise<PaymentRow | undefined> {
  const [row] = await db
    .update(payments)
    .set(patch)
    .where(and(eq(payments.id, id), eq(payments.version, expectedVersion)))
    .returning();
  return row;
}

/**
 * Ids of payments whose slip is still waiting to be read, oldest change first (the sweep job).
 * `ocr` picks rows waiting for the amount reading (`slip_check`), `verify` rows waiting for the
 * bank check (`slip_verify`); each kind is switched on by its own setting, so a leftover
 * `pending` of a kind that is off is never picked.
 */
export async function listPendingSlipChecks(
  db: Db,
  limit: number,
  kinds: { ocr: boolean; verify: boolean } = { ocr: true, verify: false },
): Promise<string[]> {
  const waiting = [
    kinds.ocr ? eq(payments.slipCheck, 'pending') : undefined,
    kinds.verify ? eq(payments.slipVerify, 'pending') : undefined,
  ].filter((c) => c !== undefined);
  if (waiting.length === 0) return [];
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(or(...waiting), isNotNull(payments.slipImageKey)))
    .orderBy(asc(payments.rev))
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------- Slip2Go daily usage (D-27) ----------

/** How many Slip2Go calls were made on this business date. */
export async function slipVerifyCallsOn(db: Db, businessDate: string): Promise<number> {
  const [row] = await db
    .select({ n: slipVerifyDaily.n })
    .from(slipVerifyDaily)
    .where(and(eq(slipVerifyDaily.businessDate, businessDate), eq(slipVerifyDaily.kind, 'calls')));
  return row?.n ?? 0;
}

/** Counts one Slip2Go call on this business date. */
export async function recordSlipVerifyCall(db: Db, businessDate: string): Promise<void> {
  await db
    .insert(slipVerifyDaily)
    .values({ businessDate, kind: 'calls' })
    .onConflictDoUpdate({
      target: [slipVerifyDaily.businessDate, slipVerifyDaily.kind],
      set: { n: sql`${slipVerifyDaily.n} + 1` },
    });
}

/** True for the first caller of this alert on this business date, false after (the key is the gate). */
export async function claimSlipVerifyAlert(
  db: Db,
  businessDate: string,
  alert: 'account' | 'cap',
): Promise<boolean> {
  const rows = await db
    .insert(slipVerifyDaily)
    .values({ businessDate, kind: `alert_${alert}` })
    .onConflictDoNothing()
    .returning({ n: slipVerifyDaily.n });
  return rows.length > 0;
}

/**
 * Payment statuses whose slip counts as "already used" (D-26): a claim that is waiting, a
 * confirmed payment, and a refunded one (the transfer was real). Pending has no slip; cancelled
 * and voided payments were rejected or taken back, so their slips do not count.
 */
const SLIP_USED_STATUSES = ['claimed', 'confirmed', 'refunded'];

/** What made two slips look like one: the reference in the slip's QR is the strongest. */
export type SlipMatch = 'qr' | 'ref' | 'image';

/**
 * The earlier payment (any order) that holds the same slip picture, the same bank reference or
 * the same QR reference as this one, or undefined. "Earlier" is by the time of the claim. It
 * returns only what staff may see: the order's number, the payment's status and what matched.
 */
export async function findEarlierSlipUse(
  db: Db,
  payment: Pick<PaymentRow, 'id' | 'claimedAt' | 'slipImageHash' | 'slipRefHash' | 'slipQrHash'>,
): Promise<{ orderNo: string; status: PaymentStatus; matchedBy: SlipMatch } | undefined> {
  const same = [
    payment.slipImageHash ? eq(payments.slipImageHash, payment.slipImageHash) : undefined,
    payment.slipRefHash ? eq(payments.slipRefHash, payment.slipRefHash) : undefined,
    payment.slipQrHash ? eq(payments.slipQrHash, payment.slipQrHash) : undefined,
  ].filter((c) => c !== undefined);
  if (same.length === 0 || payment.claimedAt === null) return undefined;
  const [row] = await db
    .select({
      orderNo: orders.orderNo,
      status: payments.status,
      imageHash: payments.slipImageHash,
      refHash: payments.slipRefHash,
      qrHash: payments.slipQrHash,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        ne(payments.id, payment.id),
        inArray(payments.status, SLIP_USED_STATUSES),
        or(...same),
        or(
          lt(payments.claimedAt, payment.claimedAt),
          and(eq(payments.claimedAt, payment.claimedAt), lt(payments.id, payment.id)),
        ),
      ),
    )
    .orderBy(asc(payments.claimedAt), asc(payments.id))
    .limit(1);
  if (!row) return undefined;
  const matchedBy: SlipMatch =
    payment.slipQrHash && row.qrHash === payment.slipQrHash
      ? 'qr'
      : payment.slipRefHash && row.refHash === payment.slipRefHash
        ? 'ref'
        : 'image';
  return { orderNo: row.orderNo, status: row.status as PaymentStatus, matchedBy };
}

/**
 * ANY other payment that holds the same slip picture, bank reference or QR reference, whenever it
 * was claimed (D-27). `findEarlierSlipUse` only looks backwards in time, which is right for a hint
 * to staff but not for an automatic confirmation: the key from Slip2Go arrives at check time, so
 * the checks of two photos of one transfer can run in either order, and each must see the other.
 */
export async function findOtherSlipUse(
  db: Db,
  payment: Pick<PaymentRow, 'id' | 'slipImageHash' | 'slipRefHash' | 'slipQrHash'>,
): Promise<{ status: PaymentStatus } | undefined> {
  const same = [
    payment.slipImageHash ? eq(payments.slipImageHash, payment.slipImageHash) : undefined,
    payment.slipRefHash ? eq(payments.slipRefHash, payment.slipRefHash) : undefined,
    payment.slipQrHash ? eq(payments.slipQrHash, payment.slipQrHash) : undefined,
  ].filter((c) => c !== undefined);
  if (same.length === 0) return undefined;
  const [row] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(
      and(ne(payments.id, payment.id), inArray(payments.status, SLIP_USED_STATUSES), or(...same)),
    )
    .limit(1);
  return row ? { status: row.status as PaymentStatus } : undefined;
}

// ---------- Partial refunds (D-25) ----------

export type RefundRow = typeof paymentRefunds.$inferSelect;

export interface NewRefund {
  orderId: string;
  paymentId: string;
  amountSatang: number;
  method: 'cash' | 'promptpay';
  referenceNote?: string | null;
  reason: string;
  refundedByStaffId: string;
}

/** Records one partial refund. Rows are append-only; a trigger refuses any change or delete. */
export async function insertRefund(db: Db, refund: NewRefund): Promise<RefundRow> {
  const [row] = await db.insert(paymentRefunds).values(refund).returning();
  if (!row) throw new Error('refund insert returned no row');
  return row;
}

/** Every partial refund of an order, oldest first. */
export async function listRefundsForOrder(db: Db, orderId: string): Promise<RefundRow[]> {
  return db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.orderId, orderId))
    .orderBy(asc(paymentRefunds.refundedAt), asc(paymentRefunds.id));
}
