import { describe, expect, test } from 'vitest';
import { compareSlipAmount, extractSlipAmount } from './slip-amount.ts';

describe('extractSlipAmount', () => {
  const cases: [name: string, text: string, satang: number | null][] = [
    ['label and unit on one line', 'จำนวน: 60.00 บาท', 6000],
    ['label then amount on the next line', 'จำนวนเงิน\n60.00', 6000],
    ['English label and THB', 'Amount 60.00 THB', 6000],
    ['thousands separator', 'จำนวนเงิน 1,250.50 บาท', 125050],
    ['big thousands separator', 'Amount: 12,345,678.90 THB', 1234567890],
    ['Thai digits', 'จำนวน ๖๐.๐๐ บาท', 6000],
    ['Thai digits with thousands', 'จำนวนเงิน ๑,๒๕๐.๕๐ บาท', 125050],
    ['one decimal digit', 'จำนวนเงิน 60.5 บาท', 6050],
    ['whole baht with the unit', 'จำนวน 60 บาท', 6000],
    ['baht sign', '฿60.00', 6000],
    ['a fee of zero is ignored', 'จำนวน: 60.00 บาท\nค่าธรรมเนียม: 0.00 บาท', 6000],
    ['a fee with its amount on the next line is ignored', 'จำนวนเงิน 60.00\nค่าธรรมเนียม\n5.00', 6000],
    ['an English fee line is ignored', 'Amount 60.00 THB\nFee 5.00 THB', 6000],
    [
      'a whole slip with date, time, reference and account',
      [
        'โอนเงินสำเร็จ',
        '11 ต.ค. 69 14:32 น.',
        'รหัสอ้างอิง 202610111432123456',
        'จาก นาย ก XXX-X-X1234-X',
        'ไปยัง ร้านแซ่บโดนเส้น',
        'จำนวน: 60.00 บาท',
        'ค่าธรรมเนียม: 0.00 บาท',
      ].join('\n'),
      6000,
    ],
    ['no label: one decimal amount with the unit', 'ยอดโอน 75.00 บาท', 7500],
    ['no label and no unit: one bare decimal amount', 'xxx\n75.00\nyyy', 7500],
    ['a date written with dots is not an amount', '11.10.2569', null],
    ['a time is not an amount', '14:32:05', null],
    ['a reference number is not an amount', 'รหัสอ้างอิง 202610111432123456', null],
    ['an account number is not an amount', 'XXX-X-X1234-X 0123456789', null],
    ['two different labelled amounts are ambiguous', 'จำนวน 60.00 บาท\nจำนวนเงิน 65.00 บาท', null],
    ['two different bare amounts are ambiguous', '60.00\n65.00', null],
    ['the same amount twice is fine', 'จำนวน 60.00 บาท\nAmount 60.00 THB', 6000],
    ['a zero amount is not an amount', 'จำนวน 0.00 บาท', null],
    ['empty text', '', null],
    ['text with no digits', 'โอนเงินสำเร็จ', null],
    ['too many digits', 'จำนวน 123456789012.00 บาท', null],
  ];

  test.each(cases)('%s', (_name, text, satang) => {
    expect(extractSlipAmount(text)).toBe(satang);
  });

  test('a labelled amount wins over a bare one', () => {
    expect(extractSlipAmount('99.00\nจำนวน: 60.00 บาท')).toBe(6000);
  });

  test('an amount with the unit wins over a bare one', () => {
    expect(extractSlipAmount('99.00\nยอด 60.00 บาท')).toBe(6000);
  });
});

describe('compareSlipAmount', () => {
  test('the same amount matches', () => {
    expect(compareSlipAmount(6000, 6000)).toBe('match');
  });

  test('another amount does not, in either direction', () => {
    expect(compareSlipAmount(5000, 6000)).toBe('mismatch');
    expect(compareSlipAmount(7000, 6000)).toBe('mismatch');
  });

  test('nothing read is unreadable', () => {
    expect(compareSlipAmount(null, 6000)).toBe('unreadable');
  });
});
