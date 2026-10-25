import { describe, expect, test } from 'vitest';
import {
  absolutePhotoUrl,
  alertText,
  CAPTION_LIMIT,
  isLinePictureUrl,
  noticeCoversTelegram,
  type TelegramAlert,
} from './message.ts';

// Made-up customer data only.
const alert: TelegramAlert = {
  kind: 'paid',
  orderNo: 'L-012',
  totalSatang: 6200,
  lineName: 'Somsri <b>&amp;</b>',
  recipientName: 'คุณสมศรี',
  building: 'ตึก B',
  lines: [
    { name: 'ก๋วยเตี๋ยวต้มยำ', qty: 2 },
    { name: 'น้ำเปล่า', qty: 1 },
  ],
  full: true,
};

describe('alertText', () => {
  test('paid: header, LINE name, name given, building, lines and total', () => {
    expect(alertText(alert).split('\n')).toEqual([
      '✅ ชำระแล้ว #L-012 · 62฿',
      'LINE: Somsri <b>&amp;</b>',
      'ชื่อ: คุณสมศรี',
      'ตึก: ตึก B',
      'ก๋วยเตี๋ยวต้มยำ × 2',
      'น้ำเปล่า × 1',
      'รวม 62฿',
    ]);
  });

  test('slip_review uses the amber header; satang show only when not whole baht', () => {
    const text = alertText({ ...alert, kind: 'slip_review', totalSatang: 6250 });
    expect(text.split('\n')[0]).toBe('🟡 ตรวจสลิป #L-012 · 62.50฿');
    expect(text).toContain('รวม 62.50฿');
  });

  test('leaves out what the customer did not give', () => {
    const text = alertText({ ...alert, lineName: null, recipientName: null, building: null });
    expect(text).not.toContain('LINE:');
    expect(text).not.toContain('ชื่อ:');
    expect(text).not.toContain('ตึก:');
  });

  test('has no field for phone, room, notes or a slip: the input type cannot carry them', () => {
    const text = alertText({
      ...alert,
      // Extra fields a careless caller might spread in must not be printed.
      ...({ phone: '0899999999', roomNo: '1204', note: 'NOTE-X', deliveryNote: 'DN-X' } as object),
    });
    for (const secret of ['0899999999', '1204', 'NOTE-X', 'DN-X']) {
      expect(text).not.toContain(secret);
    }
  });

  test('strips control characters and newlines from customer-given text', () => {
    const text = alertText({ ...alert, lineName: 'A\nB\u0000C', recipientName: 'x\r\ny' });
    expect(text.split('\n')).toHaveLength(7);
    expect(text).toContain('LINE: A B C');
  });
});

describe('absolutePhotoUrl', () => {
  test('joins the base and the photo path; an https base only', () => {
    expect(absolutePhotoUrl('https://api.example.test', '/v1/menu/items/i/photo?v=2')).toBe(
      'https://api.example.test/v1/menu/items/i/photo?v=2',
    );
    expect(absolutePhotoUrl('https://api.example.test/', '/v1/menu/items/i/photo?v=2')).toBe(
      'https://api.example.test/v1/menu/items/i/photo?v=2',
    );
    expect(absolutePhotoUrl('http://api.example.test', '/v1/x')).toBeNull();
    expect(absolutePhotoUrl('https://api.example.test', 'https://evil.test/x')).toBeNull();
  });
});

describe('isLinePictureUrl', () => {
  test('https on a LINE host only', () => {
    expect(isLinePictureUrl('https://profile.line-scdn.net/abc/preview')).toBe(true);
    expect(isLinePictureUrl('http://profile.line-scdn.net/abc')).toBe(false);
    expect(isLinePictureUrl('https://evil.test/profile.line-scdn.net')).toBe(false);
    expect(isLinePictureUrl('https://line-scdn.net.evil.test/x')).toBe(false);
    expect(isLinePictureUrl(null)).toBe(false);
  });
});

test('CAPTION_LIMIT is the Telegram caption limit', () => {
  expect(CAPTION_LIMIT).toBe(1024);
});

describe('the notice gate', () => {
  test('only a notice that names Telegram allows customer details', () => {
    expect(noticeCoversTelegram(null)).toBe(false);
    expect(noticeCoversTelegram('2026-10-23')).toBe(false);
    expect(noticeCoversTelegram('2026-10-24')).toBe(true);
    expect(noticeCoversTelegram('2026-11-01')).toBe(true);
  });

  test('without it the text is the header only', () => {
    expect(alertText({ ...alert, full: false })).toBe('✅ ชำระแล้ว #L-012 · 62฿');
  });
});
