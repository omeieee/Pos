import { createHash } from 'node:crypto';
import type { ChangePaymentMethodInput, CreatePaymentInput } from '@sds/shared';

/**
 * A fingerprint of what a payment request asks for, to tell a genuine retry (same request id,
 * same content: return the original payment) from a reused id (same request id, different
 * content: refuse). The request id is the key, not content, so it is left out; the order (and,
 * for a method change, the payment being replaced) is in, so one key cannot replay a payment onto
 * another order. No amount is in it because the client sends none.
 */
export function paymentRequestHash(
  orderId: string,
  input: CreatePaymentInput | ChangePaymentMethodInput,
  replacesPaymentId: string | null = null,
): string {
  const canonical = JSON.stringify({
    orderId,
    replacesPaymentId,
    method: input.method,
    tendered: input.method === 'cash' ? input.tendered : null,
    referenceNote: input.referenceNote ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
