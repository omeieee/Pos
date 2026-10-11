import { describe, expect, test } from 'vitest';
import { crc16Ccitt, parseSlipQr } from './slip-qr.ts';

/** TLV: tag, two-digit length, value. */
const tlv = (tag: string, value: string) =>
  `${tag}${String(value.length).padStart(2, '0')}${value}`;
/** Appends the EMVCo CRC (tag 91 here, as on slips) over everything before it, "9104" included. */
const withCrc = (body: string) => `${body}9104${crc16Ccitt(`${body}9104`)}`;
const block = (bank: string, ref: string, extra = '') =>
  tlv('00', tlv('00', '000001') + tlv('01', bank) + tlv('02', ref) + extra);

describe('crc16Ccitt', () => {
  test('is CRC-16/CCITT-FALSE: the standard check value', () => {
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });
});

/**
 * Synthetic payloads. Layout A is the Bank of Thailand slip-verify mini QR as it is described in
 * public bank/API documentation: tag 00 holds 00 = API id (000001), 01 = sending bank code,
 * 02 = transaction reference; then 51 = country, then the CRC. Layouts B and C are NOT taken from
 * real slips: they are variations (an extra sub-tag, another order, no country, no CRC) that the
 * parser must still read without guessing.
 */
const REF_A = '016285143033BTF01234';
const layoutA = withCrc(block('014', REF_A) + tlv('51', 'TH'));
const REF_B = '2026101114321234567890123';
const layoutB = withCrc(block('004', REF_B, tlv('03', 'X')));
const REF_C = '202610110000ABCD1234';
const layoutC = tlv('00', tlv('01', '025') + tlv('00', '000001') + tlv('02', REF_C));

describe('parseSlipQr', () => {
  test('layout A (API id, bank, reference, country, CRC)', () => {
    expect(layoutA.startsWith('00410006000001010301402')).toBe(true);
    expect(parseSlipQr(layoutA)).toEqual({ sendingBank: '014', transRef: REF_A });
  });

  test('layout B: an extra sub-tag and a longer reference, no country tag', () => {
    expect(parseSlipQr(layoutB)).toEqual({ sendingBank: '004', transRef: REF_B });
  });

  test('layout C: sub-tags in another order and no CRC at all', () => {
    expect(parseSlipQr(layoutC)).toEqual({ sendingBank: '025', transRef: REF_C });
  });

  test('the reference is normalised like the printed one: upper case, no hyphens', () => {
    expect(parseSlipQr(block('014', '0162851430-33btf01234'))).toEqual({
      sendingBank: '014',
      transRef: '016285143033BTF01234',
    });
  });

  test('a wrong CRC is a misread: null, never a guess', () => {
    expect(parseSlipQr(`${layoutA.slice(0, -4)}0000`)).toBeNull();
    // One changed character in the data breaks the CRC too.
    expect(parseSlipQr(layoutA.replace('BTF', 'BTG'))).toBeNull();
  });

  test('a CRC tag that is not last or not 4 hex digits is refused', () => {
    expect(parseSlipQr(`${layoutA}5102TH`)).toBeNull();
    expect(parseSlipQr(`${layoutA.slice(0, -4)}ZZZZ`)).toBeNull();
  });

  test.each([
    ['empty', ''],
    ['a URL', 'https://example.com/pay?id=1234567890'],
    [
      'a PromptPay payment QR',
      '00020101021129370016A000000677010111011300668123456785802TH53037646304ABCD',
    ],
    ['no reference', tlv('00', tlv('00', '000001') + tlv('01', '014'))],
    ['no bank code', tlv('00', tlv('00', '000001') + tlv('02', REF_A))],
    ['a bank code that is not 3 digits', block('14', REF_A)],
    [
      'an API id that is not 6 digits',
      tlv('00', tlv('00', '1') + tlv('01', '014') + tlv('02', REF_A)),
    ],
    ['a reference with too few digits', block('014', 'ABCDEFGHIJKL')],
    ['a length that runs past the end', '0041000600000101030140220016285'],
    ['a length that is not digits', '00XX0006000001'],
    ['trailing characters after the last field', `${layoutC}9`],
  ])('%s gives null', (_name, text) => {
    expect(parseSlipQr(text)).toBeNull();
  });

  test('two different slip-verify blocks are ambiguous: null', () => {
    expect(parseSlipQr(block('014', REF_A) + block('014', REF_C).replace(/^00/, '01'))).toBeNull();
  });

  test('never throws on arbitrary text', () => {
    for (const text of ['0', '00', '000', '00020', '0002AB', '\u0000\u0001', 'ก'.repeat(500)]) {
      expect(() => parseSlipQr(text)).not.toThrow();
    }
  });
});
