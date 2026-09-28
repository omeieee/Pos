import type { OrderPaymentStatus, PaymentStatus } from './enums.ts';
import { type Satang, sumSatang } from './money.ts';
import { makeMachine } from './state-machine.ts';

/**
 * Payment record status (03 §4). Only staff can confirm (CLAUDE.md rule 2):
 * a customer's "โอนแล้ว" or slip only moves a payment to `claimed`.
 */
export const paymentMachine = makeMachine<PaymentStatus>([
  { from: 'pending', to: 'claimed', staff: 'payment.record', customer: true },
  { from: 'pending', to: 'confirmed', staff: 'payment.confirm' },
  { from: 'claimed', to: 'confirmed', staff: 'payment.confirm' },
  // Method changed or order cancelled; nothing has been paid yet.
  { from: 'pending', to: 'cancelled', staff: 'payment.record', customer: true, system: true },
  // Staff checked the bank app and found no money.
  { from: 'claimed', to: 'cancelled', staff: 'payment.cancel_claimed', reasonRequired: true },
  { from: 'confirmed', to: 'voided', staff: 'payment.void_refund', reasonRequired: true },
  { from: 'confirmed', to: 'refunded', staff: 'payment.void_refund', reasonRequired: true },
]);

export interface PaymentAmount {
  status: PaymentStatus;
  amount: Satang;
}

/** Derived order payment status (03 §4), stored on the order for fast queries. */
export function derivePaymentStatus(
  orderTotal: Satang,
  payments: readonly PaymentAmount[],
): OrderPaymentStatus {
  const confirmed = sumSatang(
    payments.filter((p) => p.status === 'confirmed').map((p) => p.amount),
  );
  const anyConfirmed = payments.some((p) => p.status === 'confirmed');
  const anyRefunded = payments.some((p) => p.status === 'refunded');
  const anyClaimed = payments.some((p) => p.status === 'claimed');

  if (anyConfirmed && confirmed >= orderTotal) return 'paid';
  if (anyClaimed) return 'awaiting_confirmation';
  if (anyConfirmed) return 'partially_paid';
  if (anyRefunded) return 'refunded';
  return 'unpaid';
}
