/**
 * What the payment panel shows and allows, as pure functions (no React, no I/O), so the rules sit
 * outside the components and run in plain tests.
 *
 * Nothing here decides a business rule. Every rule comes from `@sds/shared`: the payment machine
 * says who may claim, confirm, cancel a claim or void; `calculateCashChange` and
 * `suggestCashTenders` do the cash arithmetic; `isCopayAvailable` says when co-pay may be offered
 * (the same call the server makes). The server stays the authority: this only decides what to
 * show, and every action is checked again by the API.
 *
 * Money is integer satang. The amount to pay is always the server's order total; the keypad only
 * builds a cash TENDER.
 */
import {
  bahtToSatang,
  CashPaymentError,
  calculateCashChange,
  cashChange,
  estimateGovCopaySplit,
  type GovCopayDto,
  isCopayAvailable,
  MAX_CASH_SATANG,
  type OrderDto,
  type PaymentDto,
  paymentMachine,
  paymentsSettingsSchema,
  type Satang,
  type StaffRole,
  suggestCashTenders,
} from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';

// ---------- The payments of an order ----------

/** This order's payments from the store, oldest first. */
export function paymentsOf(state: Pick<EntityState, 'payments'>, orderId: string): PaymentDto[] {
  return [...state.payments.values()]
    .filter((p) => p.orderId === orderId)
    .sort((a, b) => a.rev - b.rev || a.id.localeCompare(b.id));
}

/** The payment that was received (the latest confirmed one). */
export function confirmedPayment(payments: readonly PaymentDto[]): PaymentDto | undefined {
  return [...payments].reverse().find((p) => p.status === 'confirmed');
}

/** The payment still waiting (pending or claimed). The server allows at most one per order. */
export function openPayment(payments: readonly PaymentDto[]): PaymentDto | undefined {
  return [...payments].reverse().find((p) => p.status === 'pending' || p.status === 'claimed');
}

export type PaymentPhase =
  /** The order was cancelled: nothing can be paid. */
  | 'closed'
  | 'nothingToPay'
  | 'paid'
  /** A payment is waiting: show it (QR, steps) and the moves on it. */
  | 'open'
  /** Nothing is waiting: offer the methods. */
  | 'choose';

export function paymentPhase(order: OrderDto, payments: readonly PaymentDto[]): PaymentPhase {
  if (order.status === 'cancelled') return 'closed';
  if (order.paymentStatus === 'paid') return 'paid';
  if (order.totalSatang <= 0) return 'nothingToPay';
  // The server's own word counts too: a claimed payment may not have reached the store yet.
  if (openPayment(payments) || order.paymentStatus === 'awaiting_confirmation') return 'open';
  return 'choose';
}

// ---------- Methods on offer ----------

export type PayMethod = 'cash' | 'promptpay' | 'gov_copay';

/** How often a screen re-reads the clock to see whether the co-pay window has closed. */
export const COPAY_TICK_MS = 30_000;

export type CopayReason = 'notConfigured' | 'off' | 'notAtCounter' | 'outsideWindow';
export type CopayVerdict = { available: true } | { available: false; reason: CopayReason };

export type MethodOption =
  | { method: PayMethod; enabled: true }
  | { method: PayMethod; enabled: false; reason: CopayReason };

const isPlatformOrder = (order: Pick<OrderDto, 'channel'>) =>
  order.channel === 'grab' || order.channel === 'lineman';

/** The co-pay scheme the shop has on file, from the synced settings. */
export function govCopayScheme(settings: EntityState['settings']): GovCopayDto | undefined {
  const entry = settings.get('gov_copay');
  return entry?.id === 'gov_copay' ? entry.data : undefined;
}

/**
 * Whether co-pay may be offered for this order now. It makes the same call as the server: counter
 * payments are face to face at the storefront whatever channel the order came by, Grab and LINE MAN
 * orders are paid on their platform, and room delivery is never face to face. When it is not
 * available, the reason says why. The clock is this device's; the server decides for real.
 */
export function copayVerdict(
  scheme: GovCopayDto | undefined,
  order: Pick<OrderDto, 'channel' | 'fulfillment'>,
  nowMs: number,
): CopayVerdict {
  if (!scheme) return { available: false, reason: 'notConfigured' };
  if (!scheme.enabled) return { available: false, reason: 'off' };
  if (isPlatformOrder(order)) return { available: false, reason: 'notAtCounter' };
  const now = new Date(nowMs);
  if (isCopayAvailable(scheme, now, 'storefront', order.fulfillment)) return { available: true };
  // The time is fine for a counter order, so it is the way the order is served that rules it out.
  return isCopayAvailable(scheme, now, 'storefront', 'dine_in')
    ? { available: false, reason: 'notAtCounter' }
    : { available: false, reason: 'outsideWindow' };
}

/**
 * The methods staff may start with, in the order of the design: cash, PromptPay, ไทยช่วยไทย.
 * A method the owner switched off, or one the server refused as disabled (`hidden`), is left out.
 * Co-pay is always listed, disabled with its reason when it cannot be used (never silently gone).
 */
export function methodOptions(
  order: Pick<OrderDto, 'channel' | 'fulfillment'>,
  settings: EntityState['settings'],
  nowMs: number,
  hidden: ReadonlySet<PayMethod>,
): MethodOption[] {
  const methods = paymentsSettingsSchema.parse(settings.get('payment_methods')?.data ?? {});
  const options: MethodOption[] = [];
  if (methods.cash && !hidden.has('cash')) options.push({ method: 'cash', enabled: true });
  if (methods.promptpay && !hidden.has('promptpay')) {
    options.push({ method: 'promptpay', enabled: true });
  }
  const verdict = copayVerdict(govCopayScheme(settings), order, nowMs);
  options.push(
    verdict.available
      ? { method: 'gov_copay', enabled: true }
      : { method: 'gov_copay', enabled: false, reason: verdict.reason },
  );
  return options;
}

export interface CopayEstimate {
  govShare: Satang;
  customerShare: Satang;
  /** The government share was cut back to a cap. */
  capped: boolean;
}

function wasCapped(total: Satang, govShare: Satang, scheme: GovCopayDto): boolean {
  try {
    const uncapped = estimateGovCopaySplit(total, {
      govShareBp: scheme.govShareBp,
      govDailyCapSatang: null,
      govTotalCapSatang: null,
    });
    return govShare < uncapped.govShare;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The ESTIMATED split to show next to the full amount staff type into ถุงเงิน. Once the payment
 * exists, the server's own estimate on it is shown; before that, the shared estimate for the
 * order total. Either way it is an estimate: the app decides the real split. Null when there is
 * neither a payment nor a scheme.
 */
export function copayEstimate(
  total: Satang,
  payment: Pick<PaymentDto, 'estGovShareSatang' | 'estCustomerShareSatang'> | undefined,
  scheme: GovCopayDto | undefined,
): CopayEstimate | null {
  if (payment?.estGovShareSatang != null && payment.estCustomerShareSatang != null) {
    return {
      govShare: payment.estGovShareSatang,
      customerShare: payment.estCustomerShareSatang,
      // The payment does not say whether a cap applied: it did if the share on file is lower than
      // the same estimate without the caps. Not knowable without the scheme.
      capped: scheme ? wasCapped(total, payment.estGovShareSatang, scheme) : false,
    };
  }
  if (!scheme) return null;
  try {
    const split = estimateGovCopaySplit(total, scheme);
    return { govShare: split.govShare, customerShare: split.customerShare, capped: split.capped };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

// ---------- Cash ----------

/** One key of the keypad: a digit, "00", or one of the two editing keys. */
export type CashKey = string;

/**
 * The next digits after a key press. The keypad takes whole baht (a tender is counted in notes
 * and coins, and satang never come up at a counter); an amount above the cash limit is ignored,
 * as is a leading zero.
 */
export function pressKey(digits: string, key: CashKey): string {
  if (key === 'clear') return '';
  if (key === 'back') return digits.slice(0, -1);
  if (!/^(\d|00)$/.test(key)) return digits;
  const next = digits === '' ? key.replace(/^0+/, '') : digits + key;
  if (next === '') return '';
  return bahtToSatang(next) > MAX_CASH_SATANG ? digits : next;
}

/** The tender the digits stand for, or null when nothing has been typed. */
export function tenderedFromDigits(digits: string): Satang | null {
  return digits === '' ? null : bahtToSatang(digits);
}

export interface CashView {
  tendered: Satang | null;
  /** Shown only when the tender covers the total. */
  change: Satang | null;
  /** How much is still missing, when the tender is below the total. */
  shortBy: Satang | null;
  canConfirm: boolean;
}

/**
 * The tender after a key press. Digits continue from whole baht; an exact tender with satang
 * (฿75.50 on a total that has satang) cannot be edited digit by digit, so the next key starts a
 * new amount.
 */
export function keyToTender(current: Satang | null, key: CashKey): Satang | null {
  const digits = current === null || current % 100 !== 0 ? '' : String(current / 100);
  return tenderedFromDigits(pressKey(digits, key));
}

/** Change and the confirm gate, from the shared cash function and the SERVER's order total. */
export function cashView(total: Satang, tendered: Satang | null): CashView {
  if (tendered === null) return { tendered: null, change: null, shortBy: null, canConfirm: false };
  try {
    const result = calculateCashChange(total, tendered);
    return { tendered, change: result.change, shortBy: null, canConfirm: true };
  } catch (error) {
    if (!(error instanceof CashPaymentError)) throw error;
    if (error.code === 'tendered_below_total') {
      // total - tendered: `cashChange(amount, tendered)` is `tendered - amount`, so swap them.
      return { tendered, change: null, shortBy: cashChange(tendered, total), canConfirm: false };
    }
    return { tendered, change: null, shortBy: null, canConfirm: false };
  }
}

/** The quick tender chips: "exact", then the notes that cover the total (from the shared helper). */
export function quickTenders(total: Satang): { exact: Satang; others: Satang[] } {
  try {
    const [exact = total, ...others] = suggestCashTenders(total);
    return { exact, others };
  } catch (error) {
    if (error instanceof CashPaymentError) return { exact: total, others: [] };
    throw error;
  }
}

// ---------- Who may do what ----------

export interface PaymentActions {
  claim: boolean;
  confirm: boolean;
  changeMethod: boolean;
  cancelClaimed: boolean;
  voidRefund: boolean;
}

/**
 * The moves this role may make on this payment, read from the payment machine (the same table the
 * server uses). `changeMethod` is pending to cancelled; `cancelClaimed` is claimed to cancelled
 * ("no money found"). Void and refund are the same permission.
 */
export function paymentActions(
  role: StaffRole,
  payment: Pick<PaymentDto, 'status'>,
): PaymentActions {
  const actor = { kind: 'staff', role } as const;
  const may = (to: PaymentDto['status']) =>
    paymentMachine.transition(payment.status, to, { actor, reason: 'x' }).ok;
  return {
    claim: may('claimed'),
    confirm: may('confirmed'),
    changeMethod: payment.status === 'pending' && may('cancelled'),
    cancelClaimed: payment.status === 'claimed' && may('cancelled'),
    voidRefund: may('voided'),
  };
}
