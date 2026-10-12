import type { MessageKey } from '@sds/i18n';
import type {
  OrderPaymentsResponse,
  SlipCheck,
  SlipRecipientCheck,
  SlipVerifyVerdict,
} from '@sds/shared';

/** What the automatic reading says about the customer's slip (D-26), as the staff screen knows it. */
export interface SlipFacts {
  hasSlip: boolean;
  /** The amount check; null: not read. */
  check: SlipCheck | null;
  /** The receiver check; null or undefined: not checked. */
  recipient: SlipRecipientCheck | null | undefined;
  /** The slip was used on an earlier payment. */
  duplicate: boolean;
  /** What the bank check said (D-27); absent when the verifier is off or the list was unreadable. */
  verdict?: SlipVerifyVerdict | null | undefined;
  /** The owner reviewed this slip by hand and lifted the block: no re-check, confirm as usual. */
  reviewed?: boolean | undefined;
}

export const NO_SLIP: SlipFacts = {
  hasSlip: false,
  check: null,
  recipient: null,
  duplicate: false,
};

/**
 * Whether confirming needs the tick "I checked the incoming transfer in the shop's bank app".
 * A local duplicate always needs it. When the bank check (D-27) has answered, only `valid` keeps the
 * plain one-tap confirm; every other verdict, `pending` included, needs the tick, and the OCR
 * readings are not consulted. Without a bank verdict (verifier off, or the slip list could not be
 * read) the older rule applies: the receiver AND amount must both read as `match`. A payment without
 * a slip is the staff's own bank-app check and keeps today's flow. This is a gate on the screen
 * only: the server never blocks (rule 2), it only records the tick in the audit log.
 */
export const slipNeedsBankCheck = (f: SlipFacts): boolean => {
  if (!f.hasSlip) return false;
  if (f.duplicate) return true;
  if (f.verdict) return f.verdict !== 'valid';
  return f.recipient !== 'match' || f.check !== 'match';
};

/**
 * The amber flag "claimed, but no slip": the customer pressed "โอนแล้ว" and sent no picture, so the
 * staff must look in the bank app themselves. The server lists only claimed payments here, and
 * the list is read again at every new revision. Never dismissable; it does not block the confirm
 * button (rule 2: staff confirm by hand).
 */
export const showNoSlipFlag = (
  paymentId: string,
  claimedWithoutSlipIds: readonly string[] | undefined,
): boolean => claimedWithoutSlipIds?.includes(paymentId) === true;

/** The bank check said the slip is good and it was not used before: the "slip matches" line. */
export const slipIsBankMatched = (f: SlipFacts): boolean =>
  f.hasSlip && f.verdict === 'valid' && !f.duplicate;

/**
 * Whether the "check the slip again" button shows: a claimed payment with a slip, after a bank
 * answer that is not `valid` (unchecked, pending, not found, a mismatch ...). Without a bank answer
 * the verifier is off (or the list was unreadable), so there is nothing to ask for.
 */
export const canRecheckSlip = (status: string, f: SlipFacts): boolean =>
  status === 'claimed' && f.hasSlip && !f.reviewed && !!f.verdict && f.verdict !== 'valid';

/** The message key for a refused re-check, by the API's error code; anything else: the general one. */
export const recheckErrorKey = (code: string | undefined): MessageKey => {
  switch (code) {
    case 'SLIP_VERIFIER_OFF':
      return 'pos.slipRecheck.err.off';
    case 'PAYMENT_NOT_CLAIMED':
      return 'pos.slipRecheck.err.notClaimed';
    case 'NO_SLIP':
      return 'pos.slipRecheck.err.noSlip';
    case 'SLIP_CHECK_RUNNING':
      return 'pos.slipRecheck.err.running';
    case 'SLIP_RECHECK_LIMIT':
      return 'pos.slipRecheck.err.limit';
    case 'SLIP2GO_DAILY_CAP':
      return 'pos.slipRecheck.err.dailyCap';
    case 'SLIP_ALREADY_VALID':
      return 'pos.slipRecheck.err.alreadyValid';
    case 'SLIP_REVIEWED':
      return 'pos.slipRecheck.err.reviewed';
    default:
      return 'pos.slipRecheck.err.failed';
  }
};

/** What staff must be told about the order's slip and customer (D-27), read from the payment list. */
export interface SlipAlerts {
  /** The order's slip is blocked (the bank check said "fake slip"): staff verify by hand. */
  blocked: boolean;
  /** How many times the customer was flagged; null: no flag. */
  flagCount: number | null;
}

export const NO_ALERTS: SlipAlerts = { blocked: false, flagCount: null };

export const slipAlertsOf = (answer: OrderPaymentsResponse): SlipAlerts => ({
  blocked: (answer.slipBlocks?.length ?? 0) > 0,
  flagCount: answer.customerSlipFlag?.count ?? null,
});

/** The owner's buttons: owner role only, and each only while there is something to clear. */
export const ownerSlipActions = (
  owner: boolean,
  alerts: SlipAlerts,
  customerId: string | null | undefined,
): { clearBlock: boolean; clearFlag: boolean } => ({
  clearBlock: owner && alerts.blocked,
  clearFlag: owner && alerts.flagCount !== null && !!customerId,
});

export const SLIP_CLEAR_REASON_MAX = 200;

/** The typed reason of a clear: 1 to 200 characters after trimming (as the server checks it). */
export const slipClearReasonProblem = (text: string): 'empty' | 'tooLong' | null => {
  const reason = text.trim();
  if (reason === '') return 'empty';
  return reason.length > SLIP_CLEAR_REASON_MAX ? 'tooLong' : null;
};

/** The message key for a refused clear, by the API's error code. */
export const clearErrorKey = (code: string | undefined): MessageKey => {
  switch (code) {
    case 'SLIP_NOT_BLOCKED':
      return 'pos.slipBlock.err.notBlocked';
    case 'FORBIDDEN':
      return 'pos.slipBlock.err.forbidden';
    case 'NOT_FOUND':
      return 'pos.slipBlock.err.notFound';
    default:
      return 'pos.slipBlock.err.failed';
  }
};
