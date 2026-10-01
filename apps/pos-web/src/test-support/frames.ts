/**
 * Builders for realtime frames and the DTOs inside them, for tests. Everything is made up. Each
 * builder returns a value that passes the shared frame schema, so a test exercises the same
 * shapes the server sends.
 */
import {
  type CategoryDto,
  type GroupDto,
  type ItemDto,
  type OptionDto,
  type OrderDto,
  type PaymentDto,
  type RealtimeFrame,
  realtimeFrameSchema,
  type SyncChange,
  satang,
} from '@sds/shared';

/** A valid UUID per number: `uuid(1)`, `uuid(2)` ... */
export const uuid = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const NOW = '2030-01-01T05:00:00.000Z';

/** Checks the frame against the shared schema (so a bad fixture fails loudly) and types it. */
const parse = <T extends RealtimeFrame>(frame: unknown): T => realtimeFrameSchema.parse(frame) as T;

type MenuFrame = Extract<SyncChange, { type: 'menu.upserted' }>;

export function orderDto(id: string, rev: number, over: Partial<OrderDto> = {}): OrderDto {
  return {
    id,
    orderNo: 'S-001',
    businessDate: '2030-01-01',
    channel: 'storefront',
    fulfillment: 'dine_in',
    roomNo: null,
    customerId: null,
    status: 'new',
    paymentStatus: 'unpaid',
    subtotalSatang: satang(10000),
    discountSatang: satang(0),
    totalSatang: satang(10000),
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    placedAt: NOW,
    acceptedAt: null,
    readyAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    rev,
    items: [],
    ...over,
  };
}

export const orderFrame = (
  id: string,
  rev: number,
  over: Partial<OrderDto> = {},
): Extract<SyncChange, { type: 'order.upserted' }> =>
  parse({ type: 'order.upserted', id, rev, data: orderDto(id, rev, over) });

export function paymentDto(
  id: string,
  orderId: string,
  rev: number,
  over: Partial<PaymentDto> = {},
): PaymentDto {
  return {
    id,
    orderId,
    method: 'cash',
    status: 'confirmed',
    amountSatang: satang(10000),
    tenderedSatang: satang(10000),
    changeSatang: satang(0),
    promptpayTargetMasked: null,
    schemeId: null,
    estGovShareSatang: null,
    estCustomerShareSatang: null,
    referenceNote: null,
    claimedAt: null,
    confirmedByStaffId: null,
    confirmedAt: NOW,
    reason: null,
    version: 1,
    rev,
    ...over,
  };
}

export const paymentFrame = (
  id: string,
  orderId: string,
  rev: number,
  over: Partial<PaymentDto> = {},
): Extract<SyncChange, { type: 'payment.upserted' }> =>
  parse({ type: 'payment.upserted', id, rev, data: paymentDto(id, orderId, rev, over) });

export function categoryDto(id: string, rev: number, over: Partial<CategoryDto> = {}): CategoryDto {
  return {
    id,
    nameTh: 'ก๋วยเตี๋ยว',
    nameEn: 'Noodles',
    sort: 0,
    active: true,
    version: 1,
    rev,
    ...over,
  };
}

export const categoryFrame = (id: string, rev: number, over: Partial<CategoryDto> = {}) =>
  parse<MenuFrame>({
    type: 'menu.upserted',
    kind: 'category',
    id,
    rev,
    data: categoryDto(id, rev, over),
  });

export function itemDto(id: string, rev: number, over: Partial<ItemDto> = {}): ItemDto {
  return {
    id,
    categoryId: uuid(900),
    nameTh: 'ก๋วยเตี๋ยวต้มยำ',
    nameEn: 'Tom yum noodles',
    descriptionTh: null,
    descriptionEn: null,
    priceSatang: satang(5000),
    imageUrl: null,
    isAvailable: true,
    channels: ['storefront', 'line'],
    channelPrices: {},
    modifierGroupIds: [],
    sort: 0,
    archived: false,
    version: 1,
    rev,
    ...over,
  };
}

export const itemFrame = (id: string, rev: number, over: Partial<ItemDto> = {}) =>
  parse<MenuFrame>({
    type: 'menu.upserted',
    kind: 'item',
    id,
    rev,
    data: itemDto(id, rev, over),
  });

export function optionDto(
  id: string,
  groupId: string,
  rev: number,
  over: Partial<OptionDto> = {},
): OptionDto {
  return {
    id,
    groupId,
    nameTh: 'เส้นเล็ก',
    nameEn: 'Thin',
    priceDeltaSatang: satang(0),
    isAvailable: true,
    sort: 0,
    archived: false,
    version: 1,
    rev,
    ...over,
  };
}

export const optionFrame = (
  id: string,
  groupId: string,
  rev: number,
  over: Partial<OptionDto> = {},
) =>
  parse<MenuFrame>({
    type: 'menu.upserted',
    kind: 'option',
    id,
    rev,
    data: optionDto(id, groupId, rev, over),
  });

export function groupDto(
  id: string,
  rev: number,
  over: Partial<Omit<GroupDto, 'options'>> & {
    options?: { id: string; rev: number; isAvailable?: boolean }[];
  } = {},
): GroupDto {
  const { options = [], ...rest } = over;
  return {
    id,
    nameTh: 'เส้น',
    nameEn: 'Noodle',
    minSelect: 0,
    maxSelect: 1,
    sort: 0,
    archived: false,
    version: 1,
    rev,
    options: options.map((o) =>
      optionDto(o.id, id, o.rev, o.isAvailable === undefined ? {} : { isAvailable: o.isAvailable }),
    ),
    ...rest,
  };
}

export const groupFrame = (id: string, rev: number, over: Parameters<typeof groupDto>[2] = {}) =>
  parse<MenuFrame>({
    type: 'menu.upserted',
    kind: 'group',
    id,
    rev,
    data: groupDto(id, rev, over),
  });

export function settingsFrame(
  key: 'shop' | 'promptpay',
  rev: number,
  version: number,
): Extract<SyncChange, { type: 'settings.updated' }> {
  const data =
    key === 'shop'
      ? { nameTh: 'แซ่บโดนเส้น', nameEn: null, phone: null, address: null }
      : { idType: 'phone' as const, idMasked: '******1234' };
  return parse<Extract<SyncChange, { type: 'settings.updated' }>>({
    type: 'settings.updated',
    id: key,
    rev,
    version,
    data,
  });
}

export const alertFrame = (id: string): Extract<RealtimeFrame, { type: 'alert.new_order' }> =>
  parse({
    type: 'alert.new_order',
    id,
    data: {
      orderNo: 'S-001',
      channel: 'storefront',
      status: 'new',
      createdOnDeviceId: null,
    },
  });
