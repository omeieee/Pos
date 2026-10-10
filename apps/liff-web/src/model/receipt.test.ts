import type { MyOrder } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { canDownloadReceipt, receiptFileName, receiptHtml } from './receipt.ts';

const order = {
  orderNo: 'L-012',
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: 12000,
  items: [
    {
      nameTh: 'ก๋วยเตี๋ยว <b>',
      nameEn: 'Noodles',
      qty: 2,
      modifiers: [],
      note: null,
      lineTotalSatang: 12000,
    },
  ],
  payment: { id: 'p', method: 'promptpay', status: 'confirmed', amountSatang: 12000 },
  placedAt: '2026-10-11T05:00:00.000Z',
  completedAt: null,
} as unknown as MyOrder;

describe('customer receipt', () => {
  test('is offered only for a paid order that is not cancelled', () => {
    expect(canDownloadReceipt(order)).toBe(true);
    expect(canDownloadReceipt({ ...order, paymentStatus: 'unpaid' })).toBe(false);
    expect(canDownloadReceipt({ ...order, status: 'cancelled' })).toBe(false);
  });
  test('holds the order number, items, total and method, and escapes the dish names', () => {
    const html = receiptHtml(order, 'th');
    expect(html).toContain('L-012');
    expect(html).toContain('฿120.00');
    expect(html).toContain('พร้อมเพย์');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/<script|href=/i);
  });
  test('English locale and a safe file name', () => {
    expect(receiptHtml(order, 'en')).toContain('Noodles');
    expect(receiptFileName({ orderNo: 'L/../012' })).toBe('receipt-L..012.html'.replace('..', ''));
  });
});
