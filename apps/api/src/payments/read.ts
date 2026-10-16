/**
 * Payments: reading a payment (list with money maths, QR link, QR picture).
 */
import { customersRepo, ordersRepo, paymentsRepo } from '@sds/db';
import { promptpayPayload } from '@sds/promptpay';
import {
  maskPromptpayId,
  netPaid,
  type OrderPaymentsResponse,
  type PaymentQrUrlResponse,
  type SlipCheck,
  type SlipRecipientCheck,
  type SlipVerifyVerdict,
  satang,
} from '@sds/shared';
import type { AuthContext } from '../auth/service.ts';
import { conflict, notFound } from '../errors.ts';
import { currentPromptpayId } from '../settings/service.ts';
import { toPaymentDto } from './dto.ts';
import { moneyOf, promptpayNotConfigured, unprocessable } from './internal.ts';
import { QR_URL_TTL_SECONDS, qrPng, signQrLink } from './qr.ts';

// ---------- Read ----------

export async function listOrderPayments(
  ctx: AuthContext,
  orderId: string,
): Promise<OrderPaymentsResponse> {
  const order = await ordersRepo.findOrderById(ctx.db, orderId);
  if (!order) throw notFound('Order');
  const { rows, refunds, amounts } = await moneyOf(ctx.db, orderId);
  const paid = netPaid(amounts);
  // Slips that look used before (D-26): a hint for staff, found at read time so that a reference
  // read a moment after the claim is included.
  const duplicates: NonNullable<OrderPaymentsResponse['slipDuplicates']> = [];
  for (const r of rows) {
    if (r.slipImageKey === null) continue;
    const earlier = await paymentsRepo.findEarlierSlipUse(ctx.db, r);
    if (earlier) {
      duplicates.push({
        paymentId: r.id,
        orderNo: earlier.orderNo,
        paymentStatus: earlier.status,
        matchedBy: earlier.matchedBy,
      });
    }
  }
  const blocks = rows.flatMap((r) =>
    r.slipBlockedAt !== null
      ? [{ paymentId: r.id, at: r.slipBlockedAt.toISOString(), reason: 'fraud' as const }]
      : [],
  );
  const flag = order.customerId ? await customersRepo.getSlipFlag(ctx.db, order.customerId) : null;
  return {
    payments: rows.map(toPaymentDto),
    slipPaymentIds: rows.filter((r) => r.slipImageKey !== null).map((r) => r.id),
    claimedWithoutSlipPaymentIds: rows
      .filter((r) => r.status === 'claimed' && r.slipImageKey === null)
      .map((r) => r.id),
    ...(rows.some((r) => r.autoConfirmed)
      ? { autoConfirmedPaymentIds: rows.filter((r) => r.autoConfirmed).map((r) => r.id) }
      : {}),
    slipChecks: rows.flatMap((r) =>
      r.slipImageKey !== null && (r.slipCheck !== null || r.slipVerify !== null)
        ? [
            {
              paymentId: r.id,
              ...(r.slipCheck !== null
                ? {
                    check: r.slipCheck as SlipCheck,
                    amountSatang: r.slipAmountSatang === null ? null : satang(r.slipAmountSatang),
                  }
                : {}),
              qrFound: r.slipQrHash !== null,
              ...(r.slipRecipientCheck !== null
                ? { recipientCheck: r.slipRecipientCheck as SlipRecipientCheck }
                : {}),
              ...(r.slipVerify !== null
                ? {
                    verify: {
                      verdict: r.slipVerify as SlipVerifyVerdict,
                      ...(r.slipVerifiedAt !== null ? { at: r.slipVerifiedAt.toISOString() } : {}),
                      ...(r.slipReviewedAt !== null
                        ? { reviewedAt: r.slipReviewedAt.toISOString() }
                        : {}),
                    },
                  }
                : {}),
            },
          ]
        : [],
    ),
    ...(duplicates.length > 0 ? { slipDuplicates: duplicates } : {}),
    ...(blocks.length > 0 ? { slipBlocks: blocks } : {}),
    ...(flag
      ? {
          customerSlipFlag: {
            at: flag.at.toISOString(),
            reason: 'fraud' as const,
            count: flag.count,
          },
        }
      : {}),
    refunds: refunds.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      amountSatang: satang(r.amountSatang),
      method: r.method as 'cash' | 'promptpay',
      referenceNote: r.referenceNote,
      reason: r.reason,
      refundedAt: r.refundedAt.toISOString(),
    })),
    netPaidSatang: paid,
    dueSatang: satang(Math.max(0, order.totalSatang - paid)),
  };
}

// ---------- The QR picture ----------

const qrReady = (row: paymentsRepo.PaymentRow) =>
  row.method === 'promptpay' && (row.status === 'pending' || row.status === 'claimed');

/** A short-lived link for the staff app's `<img>`. Only for a PromptPay payment still waiting. */
export async function paymentQrUrl(
  ctx: AuthContext,
  paymentId: string,
): Promise<PaymentQrUrlResponse> {
  const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!row) throw notFound('Payment');
  if (!qrReady(row)) {
    throw conflict('QR_NOT_AVAILABLE', 'There is no PromptPay QR for this payment', {
      method: row.method,
      status: row.status,
    });
  }
  const target = await currentPromptpayId(ctx.db);
  if (!target) throw promptpayNotConfigured();
  const expiresAt = Math.floor(ctx.now().getTime() / 1000) + QR_URL_TTL_SECONDS;
  const signature = signQrLink(ctx.keys.qrUrlKey, row.id, expiresAt);
  return {
    url: `/v1/payments/${row.id}/qr.png?exp=${expiresAt}&sig=${signature}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    promptpayTargetMasked: maskPromptpayId(target.idValue),
  };
}

/**
 * The QR picture, rebuilt NOW from the current PromptPay ID in settings and the exact amount of
 * the payment (the order total). Nothing is cached or stored: a changed ID shows on the next
 * fetch. The payment must still be waiting; a confirmed, cancelled or voided one is a 404.
 */
export async function renderPaymentQr(ctx: AuthContext, paymentId: string): Promise<Buffer> {
  const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
  if (!row || !qrReady(row)) throw notFound('Payment');
  const target = await currentPromptpayId(ctx.db);
  if (!target) throw promptpayNotConfigured();
  let payload: string;
  try {
    payload = promptpayPayload(target, satang(row.amountSatang));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw unprocessable(
      'PROMPTPAY_PAYLOAD_INVALID',
      'A PromptPay QR cannot be made for this order',
    );
  }
  return qrPng(payload);
}
