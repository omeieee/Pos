/**
 * Queries for payments. Only packages/db imports the ORM, so apps/api calls these inside its own
 * transaction. Rules (state machine, who may confirm, step-up, what the order's payment status is)
 * stay in apps/api and packages/shared.
 *
 * Lock order, always: the order row first (`ordersRepo.lockOrderById`), then payment rows. Every
 * payment write takes the order lock, so two requests for one order queue up on it and cannot both
 * see "no open payment". The same order everywhere also rules out a deadlock.
 */
import type { PaymentMethod, PaymentStatus } from '@sds/shared';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { paymentRefunds, payments } from './schema.ts';

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
