import { type PromptpaySettings, satang } from '@sds/shared';
import reference from 'promptpay-qr';
import { describe, expect, test } from 'vitest';
import { crc16, decodeTlv, formatAmount, hasValidCrc, promptpayPayload } from './payload.ts';

// Test identifiers only. 0642230924 is the owner's personal test account (01-requirements P3).
const TARGETS: PromptpaySettings[] = [
  { idType: 'phone', idValue: '0642230924' },
  { idType: 'phone', idValue: '0812345678' },
  { idType: 'national_id', idValue: '1234567890123' },
  { idType: 'ewallet', idValue: '123456789012345' },
];

function toMap(payload: string): Record<string, string> {
  const top = Object.fromEntries(decodeTlv(payload).map((f) => [f.tag, f.value]));
  const merchant = Object.fromEntries(
    decodeTlv(top['29'] ?? '').map((f) => [`29.${f.tag}`, f.value]),
  );
  const { '63': _crc, '29': _m, ...rest } = top;
  return { ...rest, ...merchant };
}

/** Deterministic amount matrix: edges plus a pseudo-random sweep from ฿0.01 to ฿99,999.99. */
function amountMatrix(): number[] {
  const amounts = [1, 9, 10, 99, 100, 101, 1000, 4550, 7500, 12345, 99999, 100000, 9999999];
  let seed = 20260929;
  for (let i = 0; i < 300; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    amounts.push(1 + (seed % 9999999));
  }
  return amounts;
}

describe('crc16 (CRC-16/CCITT-FALSE)', () => {
  test('standard check value', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
  test('pads to 4 uppercase hex digits', () => {
    for (let i = 0; i < 2000; i++) expect(crc16(`x${i}`)).toMatch(/^[0-9A-F]{4}$/);
  });
  test('rejects non-ASCII', () => {
    expect(() => crc16('฿')).toThrow(RangeError);
  });
});

describe('formatAmount', () => {
  test.each([
    [1, '0.01'],
    [10, '0.10'],
    [100, '1.00'],
    [4550, '45.50'],
    [7500, '75.00'],
    [9999999, '99999.99'],
  ])('%i → %s', (a, s) => {
    expect(formatAmount(satang(a))).toBe(s);
  });
  test.each([0, -1, 1_000_000_000])('rejects %i', (a) => {
    expect(() => formatAmount(satang(a))).toThrow(RangeError);
  });
});

test('worked example from 04-integrations §2.1 (0642230924, ฿75.00)', () => {
  const payload = promptpayPayload(TARGETS[0] as PromptpaySettings, satang(7500));
  expect(payload.slice(0, -4)).toBe(
    '00020101021229370016A000000677010111011300666422309245303764540575.005802TH6304',
  );
  expect(hasValidCrc(payload)).toBe(true);
});

describe('matches the reference library promptpay-qr', () => {
  const cases = TARGETS.flatMap((t) =>
    amountMatrix().map((a) => [t.idType, t.idValue, a] as const),
  );
  test.each(cases)('%s %s, %i satang', (idType, idValue, amount) => {
    const target = { idType, idValue } as PromptpaySettings;
    const ours = promptpayPayload(target, satang(amount));
    const ref = reference(idValue, { amount: amount / 100 });

    expect(toMap(ours)).toEqual(toMap(ref));
    expect(hasValidCrc(ours)).toBe(true);
    // Our CRC routine reproduces the reference CRC on the reference payload.
    expect(crc16(ref.slice(0, -4))).toBe(ref.slice(-4));
  });
});

describe('payload structure', () => {
  const payload = promptpayPayload(TARGETS[0] as PromptpaySettings, satang(4550));
  const fields = decodeTlv(payload);
  test('00 first, 63 last, dynamic, THB, TH', () => {
    expect(fields[0]).toEqual({ tag: '00', value: '01' });
    expect(fields.at(-1)?.tag).toBe('63');
    expect(toMap(payload)).toMatchObject({ '01': '12', '53': '764', '54': '45.50', '58': 'TH' });
  });
  test('a changed amount changes the CRC and a tampered payload fails the check', () => {
    const other = promptpayPayload(TARGETS[0] as PromptpaySettings, satang(4551));
    expect(other.slice(-4)).not.toBe(payload.slice(-4));
    expect(hasValidCrc(payload.replace('45.50', '45.51'))).toBe(false);
  });
});

describe('rejects bad targets', () => {
  test.each([
    { idType: 'phone', idValue: '642230924' },
    { idType: 'phone', idValue: '06422309245' },
    { idType: 'national_id', idValue: '123456789012' },
    { idType: 'ewallet', idValue: '12345678901234' },
  ] as PromptpaySettings[])('%j', (t) => {
    expect(() => promptpayPayload(t, satang(100))).toThrow(RangeError);
  });
});
