import { describe, expect, test } from 'vitest';
import {
  SLIP_VERIFY_VERDICTS,
  satangToSlip2goAmount,
  slip2goAmountToSatang,
  slip2goReceivers,
  slip2goResponseSchema,
  slip2goVerdict,
} from './slip-verify.ts';

describe('amount converters', () => {
  const cases: [satang: number, text: string][] = [
    [100, '1.00'],
    [5000, '50.00'],
    [8550, '85.50'],
    [123405, '1234.05'],
    [1, '0.01'],
  ];
  test.each(cases)('satang %i is "%s" and back', (satang, text) => {
    expect(satangToSlip2goAmount(satang)).toBe(text);
    expect(slip2goAmountToSatang(text)).toBe(satang);
  });

  test('numbers from the API (baht) convert exactly', () => {
    expect(slip2goAmountToSatang(1)).toBe(100);
    expect(slip2goAmountToSatang(50)).toBe(5000);
    expect(slip2goAmountToSatang(85.5)).toBe(8550);
    expect(slip2goAmountToSatang('85.5')).toBe(8550);
    expect(slip2goAmountToSatang(1234.05)).toBe(123405);
    expect(slip2goAmountToSatang(0.01)).toBe(1);
  });

  test('anything that is not a clean baht amount is null', () => {
    const bad: (number | string)[] = [
      0.1 + 0.2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      '-1',
      '1.234',
      '1e3',
      1e21,
      '',
      ' 1',
      '1,000.00',
      '.5',
      '5.',
    ];
    for (const value of bad) expect(slip2goAmountToSatang(value)).toBeNull();
  });

  test('the formatter refuses what is not a non-negative safe integer', () => {
    expect(() => satangToSlip2goAmount(-1)).toThrow(RangeError);
    expect(() => satangToSlip2goAmount(1.5)).toThrow(RangeError);
  });
});

describe('slip2goReceivers', () => {
  test('a 10-digit phone is 02001, a 13-digit ID 02003, a 15-digit wallet 02004', () => {
    expect(slip2goReceivers('0812345678', null)).toEqual([
      { accountType: '02001', accountNumber: '0812345678' },
    ]);
    expect(slip2goReceivers('1234567890123', null)).toEqual([
      { accountType: '02003', accountNumber: '1234567890123' },
    ]);
    expect(slip2goReceivers('123456789012345', null)).toEqual([
      { accountType: '02004', accountNumber: '123456789012345' },
    ]);
  });

  test('dashes and spaces are dropped; an odd shape is not sent', () => {
    expect(slip2goReceivers('081-234-5678', null)).toEqual([
      { accountType: '02001', accountNumber: '0812345678' },
    ]);
    expect(slip2goReceivers('12345', null)).toEqual([]);
  });

  test('a bank account needs its bank code and adds a 01xxx entry', () => {
    expect(slip2goReceivers(null, { bankCode: '004', accountNumber: '1234567890' })).toEqual([
      { accountType: '01004', accountNumber: '1234567890' },
    ]);
    expect(
      slip2goReceivers('0812345678', { bankCode: '014', accountNumber: '1234567890' }),
    ).toEqual([
      { accountType: '02001', accountNumber: '0812345678' },
      { accountType: '01014', accountNumber: '1234567890' },
    ]);
    expect(slip2goReceivers(null, { bankCode: '', accountNumber: '1234567890' })).toEqual([]);
  });

  test('nothing configured gives an empty list', () => {
    expect(slip2goReceivers(null, null)).toEqual([]);
  });
});

describe('slip2goVerdict', () => {
  test('200200 is the only valid', () => {
    expect(slip2goVerdict('200200', true)).toEqual({
      verdict: 'valid',
      retry: false,
      alert: false,
    });
    expect(slip2goVerdict('200200', null).verdict).toBe('valid');
  });

  test('a local amount that differs overrides a valid', () => {
    expect(slip2goVerdict('200200', false).verdict).toBe('amount_mismatch');
  });

  test('200000 (found, no conditions applied) fails closed', () => {
    expect(slip2goVerdict('200000', true)).toEqual({
      verdict: 'unchecked',
      retry: false,
      alert: false,
    });
  });

  const mapped: [code: string, verdict: string][] = [
    ['200401', 'receiver_mismatch'],
    ['200402', 'amount_mismatch'],
    ['200403', 'date_mismatch'],
    ['200404', 'not_found'],
    ['200500', 'fraud'],
    ['200501', 'unchecked'],
  ];
  test.each(mapped)('%s is %s', (code, verdict) => {
    expect(slip2goVerdict(code, true)).toEqual({ verdict, retry: false, alert: false });
  });

  test('200502, 429000 and 5xx are retried', () => {
    for (const code of ['200502', '429000', '500500', '500503']) {
      expect(slip2goVerdict(code, null)).toEqual({
        verdict: 'unchecked',
        retry: true,
        alert: false,
      });
    }
  });

  test('401004 to 401007 alert the owner; other 4xxxxx just fall back', () => {
    for (const code of ['401004', '401005', '401006', '401007']) {
      expect(slip2goVerdict(code, null)).toEqual({
        verdict: 'unchecked',
        retry: false,
        alert: true,
      });
    }
    for (const code of ['401001', '401002', '401003', '400400', '400001']) {
      expect(slip2goVerdict(code, null)).toEqual({
        verdict: 'unchecked',
        retry: false,
        alert: false,
      });
    }
  });

  test('unknown codes are unchecked', () => {
    for (const code of ['', 'abc', '999999', '200001']) {
      expect(slip2goVerdict(code, true).verdict).toBe('unchecked');
    }
  });

  test('every verdict is in the enum', () => {
    for (const code of ['200200', '200401', '200402', '200403', '200404', '200500', '1']) {
      expect(SLIP_VERIFY_VERDICTS).toContain(slip2goVerdict(code, true).verdict);
    }
  });
});

describe('slip2goResponseSchema', () => {
  test('keeps only the fields we need and drops names and accounts', () => {
    const parsed = slip2goResponseSchema.parse({
      code: '200200',
      message: 'Slip is valid',
      data: {
        referenceId: 'ref-1',
        transRef: '0'.repeat(25),
        amount: 15,
        dateTime: '2026-10-12T10:00:00+07:00',
        sender: { bank: { id: '002', name: 'x' }, account: { name: 'secret name' } },
        receiver: { account: { name: 'other name', proxy: { account: 'xxx' } } },
        extra: 1,
      },
    });
    expect(parsed).toEqual({
      code: '200200',
      message: 'Slip is valid',
      data: {
        referenceId: 'ref-1',
        transRef: '0'.repeat(25),
        amount: 15,
        dateTime: '2026-10-12T10:00:00+07:00',
        sender: { bank: { id: '002' } },
      },
    });
  });

  test('a response with no data is fine, and a missing code is not', () => {
    expect(slip2goResponseSchema.parse({ code: '401004', message: 'x' }).data).toBeUndefined();
    expect(slip2goResponseSchema.safeParse({ message: 'x' }).success).toBe(false);
  });
});
