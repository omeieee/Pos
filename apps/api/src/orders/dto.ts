import type { syncRepo } from '@sds/db';
import { type OrderDto, orderDtoSchema } from '@sds/shared';

/**
 * Database rows to the API shape. Parsing through the shared schema keeps the contract in one
 * place and drops the cost snapshot that is stored with each line and modifier: devices never
 * see what a bowl costs. The parameters are the feed's allow-listed rows (`syncRepo`): a full row
 * fits them, and this function cannot read a column that is not on the list.
 */
export function toOrderDto(
  order: syncRepo.SyncOrderRow,
  items: readonly syncRepo.SyncOrderItemRow[],
): OrderDto {
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return orderDtoSchema.parse({
    id: order.id,
    orderNo: order.orderNo,
    businessDate: order.businessDate,
    channel: order.channel,
    fulfillment: order.fulfillment,
    roomNo: order.roomNo,
    deliveryBuilding: order.deliveryBuilding,
    recipientName: order.recipientName,
    deliveryNote: order.deliveryNote,
    customerId: order.customerId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotalSatang: order.subtotalSatang,
    discountSatang: order.discountSatang,
    totalSatang: order.totalSatang,
    note: order.note,
    createdByStaffId: order.createdByStaffId,
    createdOnDeviceId: order.createdOnDeviceId,
    placedAt: order.placedAt.toISOString(),
    acceptedAt: iso(order.acceptedAt),
    readyAt: iso(order.readyAt),
    completedAt: iso(order.completedAt),
    cancelledAt: iso(order.cancelledAt),
    cancelReason: order.cancelReason,
    version: order.version,
    rev: order.rev,
    items: items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      nameTh: item.nameThSnapshot,
      nameEn: item.nameEnSnapshot,
      unitPriceSatang: item.unitPriceSatang,
      qty: item.qty,
      modifiers: item.modifiers,
      note: item.note,
      lineTotalSatang: item.lineTotalSatang,
    })),
  });
}
