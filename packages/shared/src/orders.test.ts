import { describe, expect, test } from 'vitest';
import {
  cancelOrderInputSchema,
  listOrdersQuerySchema,
  orderDtoSchema,
  patchOrderInputSchema,
  transitionOrderInputSchema,
} from './orders.ts';
import { createOrderInputSchema } from './schemas.ts';

const uuid = '0192f3a0-0000-7000-8000-000000000001';

describe('createOrderInputSchema ignores prices a client might send', () => {
  test('totals, prices and costs never reach the server logic', () => {
    const parsed = createOrderInputSchema.parse({
      clientRequestId: uuid,
      channel: 'storefront',
      fulfillment: 'takeaway',
      totalSatang: 1,
      subtotalSatang: 1,
      discountSatang: 99999,
      items: [
        {
          menuItemId: uuid,
          qty: 1,
          unitPriceSatang: 1,
          lineTotalSatang: 1,
          modifierOptionIds: [],
        },
      ],
    });
    const json = JSON.stringify(parsed);
    expect(json).not.toMatch(/total|subtotal|discount|unitPrice|lineTotal/i);
  });
});

describe('patchOrderInputSchema', () => {
  test('needs the version the client saw and at least one field to change', () => {
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 1, note: 'ไม่เผ็ด' }).success).toBe(
      true,
    );
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 1, roomNo: '1204' }).success).toBe(
      true,
    );
    expect(patchOrderInputSchema.safeParse({ note: 'x' }).success).toBe(false);
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 0, note: 'x' }).success).toBe(false);
  });

  test('can clear the note, but not the room number to an empty string', () => {
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 2, note: null }).success).toBe(true);
    expect(patchOrderInputSchema.safeParse({ expectedVersion: 2, roomNo: '  ' }).success).toBe(
      false,
    );
  });

  test('refuses money fields instead of ignoring them', () => {
    for (const field of ['totalSatang', 'subtotalSatang', 'discountSatang', 'status', 'items']) {
      expect(
        patchOrderInputSchema.safeParse({ expectedVersion: 1, note: 'x', [field]: 1 }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('transition and cancel inputs', () => {
  test('a transition names the target status; reason and version are optional', () => {
    expect(transitionOrderInputSchema.parse({ to: 'ready' })).toEqual({ to: 'ready' });
    expect(transitionOrderInputSchema.safeParse({ to: 'paid' }).success).toBe(false);
    expect(transitionOrderInputSchema.safeParse({}).success).toBe(false);
    expect(
      transitionOrderInputSchema.parse({
        to: 'cancelled',
        reason: ' หมดเวลา ',
        expectedVersion: 3,
      }),
    ).toEqual({
      to: 'cancelled',
      reason: 'หมดเวลา',
      expectedVersion: 3,
    });
  });

  test('a cancel always carries a reason', () => {
    expect(cancelOrderInputSchema.safeParse({ reason: 'ลูกค้ายกเลิก' }).success).toBe(true);
    expect(cancelOrderInputSchema.safeParse({}).success).toBe(false);
    expect(cancelOrderInputSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });
});

describe('listOrdersQuerySchema', () => {
  test('all filters are optional; the day is a calendar date', () => {
    expect(listOrdersQuerySchema.parse({})).toEqual({});
    expect(
      listOrdersQuerySchema.parse({ day: '2026-10-01', status: 'new', channel: 'line' }),
    ).toEqual({
      day: '2026-10-01',
      status: 'new',
      channel: 'line',
    });
    expect(listOrdersQuerySchema.safeParse({ day: '01/10/2026' }).success).toBe(false);
    expect(listOrdersQuerySchema.safeParse({ status: 'paid' }).success).toBe(false);
    expect(listOrdersQuerySchema.safeParse({ channel: 'fax' }).success).toBe(false);
  });
});

describe('orderDtoSchema', () => {
  const dto = {
    id: uuid,
    orderNo: 'S-012',
    businessDate: '2026-10-01',
    channel: 'storefront',
    fulfillment: 'takeaway',
    roomNo: null,
    customerId: null,
    status: 'preparing',
    paymentStatus: 'unpaid',
    subtotalSatang: 5000,
    discountSatang: 0,
    totalSatang: 5000,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    placedAt: '2026-10-01T03:00:00.000Z',
    acceptedAt: null,
    readyAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    rev: 7,
    items: [],
  };

  test('accepts the shape the API returns', () => {
    expect(orderDtoSchema.safeParse(dto).success).toBe(true);
  });

  test('has no cost fields: kitchen devices must not see what a bowl costs', () => {
    expect(Object.keys(orderDtoSchema.shape).join()).not.toMatch(/cost/i);
  });
});
