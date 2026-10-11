import type { SlipCheck, SlipRecipientCheck } from '@sds/shared';

/** What the automatic reading says about the customer's slip (D-26), as the staff screen knows it. */
export interface SlipFacts {
  hasSlip: boolean;
  /** The amount check; null: not read. */
  check: SlipCheck | null;
  /** The receiver check; null or undefined: not checked. */
  recipient: SlipRecipientCheck | null | undefined;
  /** The slip was used on an earlier payment. */
  duplicate: boolean;
}

export const NO_SLIP: SlipFacts = {
  hasSlip: false,
  check: null,
  recipient: null,
  duplicate: false,
};

/**
 * Whether confirming needs the tick "I checked the incoming transfer in the shop's bank app".
 * Only a slip whose receiver AND amount both read as `match` and that is not a duplicate keeps the
 * plain one-tap confirm; anything else (mismatch, unknown, not read, duplicate) needs the tick.
 * A payment without a slip is the staff's own bank-app check and keeps today's flow. This is a gate
 * on the screen only: the server never blocks (rule 2), it only records the tick in the audit log.
 */
export const slipNeedsBankCheck = (f: SlipFacts): boolean =>
  f.hasSlip && (f.recipient !== 'match' || f.check !== 'match' || f.duplicate);
