import type { paymentsRepo } from '@sds/db';
import { type PaymentDto, paymentDtoSchema } from '@sds/shared';

/**
 * Database row to API shape. Parsing through the shared schema keeps the contract in one place
 * and drops everything a device must not see: the stored QR payload (it holds the PromptPay ID
 * in clear), the slip fields and the request fingerprint.
 */
export function toPaymentDto(row: paymentsRepo.PaymentRow): PaymentDto {
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return paymentDtoSchema.parse({
    id: row.id,
    orderId: row.orderId,
    method: row.method,
    status: row.status,
    amountSatang: row.amountSatang,
    tenderedSatang: row.tenderedSatang,
    changeSatang: row.changeSatang,
    promptpayTargetMasked: row.promptpayTargetMasked,
    schemeId: row.schemeId,
    estGovShareSatang: row.estGovShareSatang,
    estCustomerShareSatang: row.estCustomerShareSatang,
    referenceNote: row.referenceNote,
    claimedAt: iso(row.claimedAt),
    confirmedByStaffId: row.confirmedByStaffId,
    confirmedAt: iso(row.confirmedAt),
    reason: row.voidReason,
    version: row.version,
    rev: row.rev,
  });
}
