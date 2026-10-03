/**
 * The chat message the customer app sends with `liff.sendMessages()` right after an order is
 * placed. LINE then delivers it to the webhook with a reply token, so the shop's confirmation
 * goes out as a free reply. Anyone can type this text, so the webhook never trusts it: it looks
 * the order up by number AND by the sender's own LINE user id (see `apps/api/src/line`).
 */
const ORDER_NO = /^[A-Z]-\d{3,6}$/;

export function orderPlacedText(orderNo: string): string {
  if (!ORDER_NO.test(orderNo)) throw new RangeError('not an order number');
  return `ยืนยันออเดอร์ #${orderNo}`;
}

const PLACED = /^ยืนยันออเดอร์ #([A-Z]-\d{3,6})$/;

/** The order number in a message made by `orderPlacedText`, or null for any other text. */
export function parseOrderPlacedText(text: string): string | null {
  return PLACED.exec(text.trim())?.[1] ?? null;
}
