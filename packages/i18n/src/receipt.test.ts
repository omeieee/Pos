import { describe, expect, test } from 'vitest';
import { receiptHtml } from './receipt.ts';

const order = {
  orderNo: 'S-013',
  status: 'completed',
  paymentStatus: 'paid',
  totalSatang: 7500,
  items: [{ nameTh: 'ก๋วยเตี๋ยว', nameEn: 'Noodles', qty: 1, lineTotalSatang: 7500 }],
  placedAt: '2030-10-15T05:00:00.000Z',
  completedAt: null,
  payment: { method: 'cash' },
};

describe('receiptHtml', () => {
  test('without shop data it is the customer receipt: no tax or address line', () => {
    const html = receiptHtml(order, 'th');
    expect(html).not.toContain('เลขประจำตัวผู้เสียภาษี');
    expect(html).toContain('S-013');
  });

  test('prints the tax ID and address only when set, escaped', () => {
    const shop = {
      nameTh: 'ร้านทดสอบ',
      nameEn: 'Test Shop',
      taxId: '1234567890121',
      address: '1 <Rd> & Co',
    };
    const html = receiptHtml({ ...order, shop }, 'th');
    expect(html).toContain('เลขประจำตัวผู้เสียภาษี 1234567890121');
    expect(html).toContain('1 &#60;Rd&#62; &#38; Co');
    expect(html).toContain('<h1>ร้านทดสอบ</h1>');
    expect(receiptHtml({ ...order, shop }, 'en')).toContain('Tax ID 1234567890121');
    const bare = receiptHtml({ ...order, shop: { ...shop, taxId: null, address: null } }, 'th');
    expect(bare).not.toContain('เลขประจำตัวผู้เสียภาษี');
    expect(bare).not.toContain('Rd');
  });
});
