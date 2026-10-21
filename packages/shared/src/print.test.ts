import { describe, expect, test } from 'vitest';
import type { OrderDto } from './orders.ts';
import {
  buildKitchenTicket,
  kitchenTicketSchema,
  PRINT_MAX_ATTEMPTS,
  printAckInputSchema,
  printingPatchInputSchema,
  printingSettingsSchema,
  printRetryDelaySeconds,
  stripPhoneNumbers,
} from './print.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function order(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: id(1),
    orderNo: 'L-012',
    businessDate: '2026-10-22',
    channel: 'line',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'อาคาร A',
    recipientName: 'คุณสมชาย',
    deliveryNote: 'รอที่ล็อบบี้',
    customerId: id(2),
    member: { fullName: 'สมชาย ใจดี', nickname: 'ชาย', building: 'A', phone: '0812345678' },
    line: { displayName: 'Somchai LINE', pictureUrl: 'https://example.test/p.jpg' },
    status: 'preparing',
    paymentStatus: 'unpaid',
    subtotalSatang: 7500 as never,
    discountSatang: 0 as never,
    totalSatang: 7500 as never,
    note: 'ไม่ผัก',
    createdByStaffId: null,
    createdOnDeviceId: null,
    placedAt: '2026-10-22T07:05:00.000Z',
    acceptedAt: null,
    readyAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    rev: 5,
    items: [
      {
        id: id(3),
        menuItemId: id(4),
        nameTh: 'ก๋วยเตี๋ยวต้มยำ',
        nameEn: 'Tom yum',
        unitPriceSatang: 5000 as never,
        qty: 2,
        modifiers: [
          {
            groupId: id(5),
            optionId: id(6),
            nameTh: 'เส้นเล็ก',
            nameEn: 'Thin',
            priceDeltaSatang: 0,
          },
        ],
        note: 'เผ็ดน้อย',
        lineTotalSatang: 10000 as never,
      },
    ],
    ...overrides,
  };
}

describe('stripPhoneNumbers', () => {
  test('removes Thai mobile and landline numbers in common spellings', () => {
    for (const text of [
      'โทร 0812345678 นะ',
      'โทร 081-234-5678 นะ',
      'โทร 081 234 5678 นะ',
      'โทร +66812345678 นะ',
      'โทร ๐๘๑๒๓๔๕๖๗๘ นะ',
      'โทร 02-123-4567 นะ',
    ]) {
      const out = stripPhoneNumbers(text);
      expect(out, text).not.toMatch(/[\d๐-๙]{4}/);
      expect(out, text).toContain('โทร');
      expect(out, text).toContain('นะ');
    }
  });

  test('keeps short numbers such as a room or a quantity', () => {
    expect(stripPhoneNumbers('ห้อง 1205 ชั้น 12 เผ็ด 2 ถุง')).toBe('ห้อง 1205 ชั้น 12 เผ็ด 2 ถุง');
  });
});

describe('buildKitchenTicket', () => {
  test('carries the order number, source, lines, notes and the Bangkok time', () => {
    const ticket = buildKitchenTicket(order(), { reprint: false, copy: 0 });
    expect(ticket).toMatchObject({
      orderNo: 'L-012',
      channel: 'line',
      fulfillment: 'entrance_delivery',
      building: 'อาคาร A',
      deliveryNote: 'รอที่ล็อบบี้',
      orderNote: 'ไม่ผัก',
      placedDate: '2026-10-22',
      // 07:05 UTC is 14:05 in Bangkok.
      placedTime: '14:05',
      reprint: false,
      copy: 0,
    });
    expect(ticket.lines).toEqual([
      { qty: 2, nameTh: 'ก๋วยเตี๋ยวต้มยำ', modifiers: ['เส้นเล็ก'], note: 'เผ็ดน้อย' },
    ]);
    expect(kitchenTicketSchema.safeParse(ticket).success).toBe(true);
  });

  test('names who it is for: the recipient first, then the nickname, then the LINE name', () => {
    expect(buildKitchenTicket(order(), { reprint: false, copy: 0 }).who).toBe('คุณสมชาย');
    expect(
      buildKitchenTicket(order({ recipientName: null }), { reprint: false, copy: 0 }).who,
    ).toBe('ชาย');
    expect(
      buildKitchenTicket(order({ recipientName: null, member: null }), {
        reprint: false,
        copy: 0,
      }).who,
    ).toBe('Somchai LINE');
    expect(
      buildKitchenTicket(order({ recipientName: null, member: null, line: null }), {
        reprint: false,
        copy: 0,
      }).who,
    ).toBeNull();
  });

  test('never holds a phone number, a customer id, a picture or any money', () => {
    const ticket = buildKitchenTicket(
      order({
        deliveryNote: 'โทร 081-234-5678 ตอนถึง',
        note: 'ติดต่อ 0899999999',
        recipientName: 'คุณ 0812345678',
      }),
      { reprint: false, copy: 0 },
    );
    const text = JSON.stringify(ticket);
    expect(text).not.toMatch(/\d{9}/);
    expect(text).not.toContain('081-234');
    expect(text).not.toContain('0812345678');
    expect(text).not.toContain('example.test');
    expect(text).not.toContain(id(2));
    expect(text).not.toContain('Satang');
    expect(Object.keys(ticket).sort()).toEqual(
      [
        'building',
        'channel',
        'copy',
        'deliveryNote',
        'fulfillment',
        'lines',
        'orderNo',
        'orderNote',
        'placedDate',
        'placedTime',
        'reprint',
        'roomNo',
        'who',
      ].sort(),
    );
  });

  test('a ticket with an unknown field is refused by the schema', () => {
    const ticket = buildKitchenTicket(order(), { reprint: false, copy: 0 });
    expect(kitchenTicketSchema.safeParse({ ...ticket, phone: '0812345678' }).success).toBe(false);
  });
});

describe('retry timing', () => {
  test('backs off and then stays at the last delay', () => {
    expect(printRetryDelaySeconds(1)).toBe(5);
    expect(printRetryDelaySeconds(2)).toBeGreaterThan(printRetryDelaySeconds(1));
    expect(printRetryDelaySeconds(PRINT_MAX_ATTEMPTS + 3)).toBe(
      printRetryDelaySeconds(PRINT_MAX_ATTEMPTS),
    );
  });
});

describe('inputs', () => {
  test('a failed ack needs an error code from the list, a printed one does not', () => {
    const leaseToken = id(9);
    expect(printAckInputSchema.safeParse({ leaseToken, result: 'printed' }).success).toBe(true);
    expect(
      printAckInputSchema.safeParse({ leaseToken, result: 'failed', errorCode: 'OUT_OF_PAPER' })
        .success,
    ).toBe(true);
    expect(printAckInputSchema.safeParse({ leaseToken, result: 'failed' }).success).toBe(false);
    expect(
      printAckInputSchema.safeParse({ leaseToken, result: 'failed', errorCode: 'a free text' })
        .success,
    ).toBe(false);
  });

  test('the printing setting is off until the owner turns it on, and a patch needs the flag', () => {
    expect(printingSettingsSchema.parse({})).toEqual({ enabled: false });
    expect(printingPatchInputSchema.safeParse({ expectedVersion: 0, enabled: true }).success).toBe(
      true,
    );
    expect(printingPatchInputSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(printingPatchInputSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});
