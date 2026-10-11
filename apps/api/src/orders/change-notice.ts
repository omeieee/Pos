/**
 * What the owner's void or edit of an order means for the customer, handed to the LINE notice after
 * the transaction has committed (owner decision 2026-10-11). Amounts only: no names, no free text.
 */
export interface OrderChangeNotice {
  kind: 'void' | 'edit';
  orderId: string;
  /** The order's version after the change: an edit's push template, so each edit sends its own. */
  version: number;
  /** The order total after the change. */
  totalSatang: number;
  /** Money handed back to the customer by this change (0 when none). */
  refundedSatang: number;
  /** Money the customer still owes after this change, for an order that held confirmed money. */
  dueSatang: number;
}
