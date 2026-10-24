/**
 * Order page: the maps from order, payment, slip and step states to message keys and badge tones.
 */
import type { MessageKey } from '@sds/i18n';
import type { MyOrder } from '@sds/shared';
import type { GiName } from '../../design/icons.tsx';

export const STATUS_KEY: Record<MyOrder['status'], MessageKey> = {
  new: 'lineBot.status.new',
  preparing: 'lineBot.status.preparing',
  ready: 'lineBot.status.ready',
  completed: 'lineBot.status.completed',
  cancelled: 'lineBot.status.cancelled',
};
export const PAYMENT_KEY: Record<MyOrder['paymentStatus'], MessageKey> = {
  unpaid: 'liff.order.payWaiting',
  awaiting_confirmation: 'status.payment.awaiting_confirmation',
  partially_paid: 'status.payment.partially_paid',
  paid: 'status.payment.paid',
  refunded: 'status.payment.refunded',
};
/** Badge look per payment status: colour, icon and word always together. */
export const PAYMENT_BADGE: Record<MyOrder['paymentStatus'], { tone: string; icon: GiName }> = {
  unpaid: { tone: 'g-b-warn', icon: 'pending' },
  awaiting_confirmation: { tone: 'g-b-info', icon: 'clock' },
  partially_paid: { tone: 'g-b-warn', icon: 'pending' },
  paid: { tone: 'g-b-ok', icon: 'check' },
  refunded: { tone: 'g-b-mute', icon: 'info' },
};
export const STATUS_BADGE: Record<MyOrder['status'], { tone: string; icon: GiName }> = {
  new: { tone: 'g-b-info', icon: 'clock' },
  preparing: { tone: 'g-b-warn', icon: 'bowl' },
  ready: { tone: 'g-b-ok', icon: 'check' },
  completed: { tone: 'g-b-mute', icon: 'check' },
  cancelled: { tone: 'g-b-bad', icon: 'x' },
};
/** One line per stage; every failure except a wrong amount shows the same neutral words. */
export const SLIP_CHECK_KEY: Record<NonNullable<MyOrder['slipCheck']>, MessageKey> = {
  none: 'liff.slipStatus.none',
  checking: 'liff.slipStatus.checking',
  staff_review: 'liff.slipStatus.staffReview',
  // The only failure told apart (D-42), and a pass the shop still has to confirm (A2).
  amount_mismatch: 'liff.slipStatus.amountMismatch',
  verified_waiting: 'liff.slipStatus.verifiedWaiting',
};
export const STEP_KEY: MessageKey[] = [
  'liff.order.step.ordered',
  'liff.order.step.pay',
  'liff.order.step.cooking',
  'liff.order.step.pickup',
];
