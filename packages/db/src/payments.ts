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
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { payments } from './schema.ts';

export type PaymentRow = typeof payments.$inferSelect;

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
