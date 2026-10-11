import { describe, expect, test } from 'vitest';
import { extractSlipRef } from './slip-ref.ts';

describe('extractSlipRef', () => {
  const cases: [name: string, text: string, ref: string | null][] = [
    ['รหัสอ้างอิง on one line', 'รหัสอ้างอิง 202610111432123456', '202610111432123456'],
    [
      'เลขที่รายการ with a colon and letters',
      'เลขที่รายการ: 016285143033BTF01234',
      '016285143033BTF01234',
    ],
    ['เลขที่อ้างอิง', 'เลขที่อ้างอิง 0162851430331234', '0162851430331234'],
    ['หมายเลขอ้างอิง', 'หมายเลขอ้างอิง: 1234567890123', '1234567890123'],
    ['English Ref No.', 'Ref No. 202610111432AB99', '202610111432AB99'],
    ['English Reference', 'Reference: 1234567890123', '1234567890123'],
    ['Transaction ID', 'Transaction ID: 6012345678901', '6012345678901'],
    ['lower case is normalised to upper case', 'ref: abcd1234567890', 'ABCD1234567890'],
    [
      'the value on the line below the label',
      'รหัสอ้างอิง\n202610111432123456\n60.00 บาท',
      '202610111432123456',
    ],
    ['Thai digits', 'รหัสอ้างอิง ๒๐๒๖๑๐๑๑๑๔๓๒๑๒๓๔๕๖', '202610111432123456'],
    [
      'a hyphen or a trailing dot is not part of the ref',
      'Ref: 2026-1011-1432-1234.',
      '2026101114321234',
    ],
    [
      'the same ref twice is still one ref',
      'รหัสอ้างอิง 202610111432123456\nRef 202610111432123456',
      '202610111432123456',
    ],
    ['bilingual label on one line', 'รหัสอ้างอิง / Ref ID: 202610111432123456', '202610111432123456'],
    [
      'a whole slip',
      [
        'โอนเงินสำเร็จ',
        '11 ต.ค. 69 14:32 น.',
        'รหัสอ้างอิง 202610111432123456',
        'จำนวน: 60.00 บาท',
        'ค่าธรรมเนียม: 0.00 บาท',
      ].join('\n'),
      '202610111432123456',
    ],
    // Ambiguous or not a reference: null, never a guess.
    ['two different refs', 'เลขที่รายการ 016285143033BTF01234\nรหัสอ้างอิง 202610111432123456', null],
    ['no label', '202610111432123456\nจำนวน 60.00 บาท', null],
    ['too short', 'Ref: 12345', null],
    ['only letters', 'Reference: Transaction', null],
    ['a label with nothing after it', 'รหัสอ้างอิง', null],
    ['the line below is not just a value', 'รหัสอ้างอิง\nวันที่ 11 ต.ค. 69', null],
    ['an amount is not a reference', 'Ref: 60.00', null],
    ['a word that merely contains ref', 'Preference 1234567890123', null],
    ['empty text', '', null],
  ];
  test.each(cases)('%s', (_name, text, ref) => {
    expect(extractSlipRef(text)).toBe(ref);
  });

  test('the answer is a plain upper-case string with no spaces or hyphens', () => {
    expect(extractSlipRef('Ref: ab12 cd34')).toBeNull();
    expect(extractSlipRef('Ref: ab12cd3456-ef78')).toBe('AB12CD3456EF78');
  });
});
