import {
  findAuditByRequestId,
  getSettingRow,
  insertAudit,
  ordersRepo,
  paymentsRepo,
} from '@sds/db';
import {
  DEFAULT_SHOP_SETTINGS,
  type IssueReceiptInput,
  type ReceiptResponse,
  shopSettingsSchema,
} from '@sds/shared';
import type { Principal, RequestMeta } from '../auth/service.ts';
import { conflict, notFound } from '../errors.ts';
import { toPaymentDto } from '../payments/dto.ts';
import { currentReceiptSettings } from '../settings/service.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { toOrderDto } from './dto.ts';

/**
 * Issues a receipt for an order whose payment staff have confirmed, and records WHO issued it for
 * WHICH order and payment (`order.receipt.issue`; never a total, a name or the tax ID). The order
 * row lock queues two issues for one order, so a retry with the same `clientRequestId` sees the
 * first one's audit row: it answers the same receipt (`replay`) and writes nothing more. A new
 * request id is a new issue (a re-print), and is audited too.
 *
 * The answer holds only what the server stored: the shop profile and receipt settings (the tax ID
 * and address are null until the owner enters them), the order, and its confirmed payment.
 */
export async function issueReceipt(
  ctx: CoreContext,
  actor: Principal,
  orderId: string,
  input: IssueReceiptInput,
  meta: RequestMeta,
): Promise<{ result: ReceiptResponse; replay: boolean }> {
  return withTransaction(ctx, async (tx) => {
    const order = await ordersRepo.lockOrderById(tx, orderId);
    if (!order) throw notFound('Order');

    // A voided or refunded payment, or one still waiting, is not a paid receipt.
    const confirmed = (await paymentsRepo.listPaymentsForOrder(tx, orderId))
      .filter((p) => p.status === 'confirmed')
      .at(-1);
    if (!confirmed) {
      throw conflict(
        'RECEIPT_NOT_AVAILABLE',
        'A receipt needs a payment that staff have confirmed',
        { orderId },
      );
    }

    const seen = await findAuditByRequestId(tx, 'orders', orderId, input.clientRequestId);
    if (seen && seen.action !== 'order.receipt.issue') {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This request id was already used for something else',
      );
    }
    if (!seen) {
      await insertAudit(tx, {
        actorType: 'staff',
        actorId: actor.staffId,
        deviceId: actor.deviceId,
        action: 'order.receipt.issue',
        entity: 'orders',
        entityId: orderId,
        after: { clientRequestId: input.clientRequestId, paymentId: confirmed.id },
        ip: meta.ip,
      });
    }

    const shopRow = await getSettingRow(tx, 'shop');
    const shop = shopRow ? shopSettingsSchema.parse(shopRow.value) : DEFAULT_SHOP_SETTINGS;
    const { taxId, address } = await currentReceiptSettings(tx);
    const items = await ordersRepo.loadOrderItems(tx, [orderId]);
    return {
      replay: seen !== undefined,
      result: {
        issuedAt: ctx.now().toISOString(),
        shop: { nameTh: shop.nameTh, nameEn: shop.nameEn, phone: shop.phone, taxId, address },
        order: toOrderDto(order, items.get(orderId) ?? []),
        payment: toPaymentDto(confirmed),
      },
    };
  });
}
