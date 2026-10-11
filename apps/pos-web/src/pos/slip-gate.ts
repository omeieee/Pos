import type { SlipCheck, SlipRecipientCheck, SlipVerifyVerdict } from '@sds/shared';

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
