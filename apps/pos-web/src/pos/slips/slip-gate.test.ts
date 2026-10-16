import { SLIP_VERIFY_VERDICTS, type SlipCheck, type SlipRecipientCheck } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { NO_SLIP, type SlipFacts, slipNeedsBankCheck } from './slip-gate.ts';

const facts = (over: Partial<SlipFacts> = {}): SlipFacts => ({
  hasSlip: true,
  check: 'match',
  recipient: 'match',
  duplicate: false,
  ...over,
});

describe('slipNeedsBankCheck (D-26): when staff must tick "I checked the bank app"', () => {
  test('a slip whose receiver and amount match and that is not a duplicate: one tap, no tick', () => {
    expect(slipNeedsBankCheck(facts())).toBe(false);
  });

  test.each<[string, SlipRecipientCheck | null | undefined]>([
    ['mismatch', 'mismatch'],
    ['unknown', 'unknown'],
    ['not checked (null)', null],
    ['absent (undefined)', undefined],
  ])('a receiver that is %s needs the tick', (_name, recipient) => {
    expect(slipNeedsBankCheck(facts({ recipient }))).toBe(true);
  });

  test.each<[string, SlipCheck | null]>([
    ['mismatch', 'mismatch'],
    ['unreadable', 'unreadable'],
    ['pending', 'pending'],
    ['no reading (null)', null],
  ])('an amount check that is %s needs the tick', (_name, check) => {
    expect(slipNeedsBankCheck(facts({ check }))).toBe(true);
  });

  test('a duplicate needs the tick even when everything else matches', () => {
    expect(slipNeedsBankCheck(facts({ duplicate: true }))).toBe(true);
  });

  test("a payment without a slip keeps today's flow, whatever the other fields say", () => {
    expect(slipNeedsBankCheck(NO_SLIP)).toBe(false);
    expect(
      slipNeedsBankCheck({
        hasSlip: false,
        check: 'mismatch',
        recipient: 'mismatch',
        duplicate: true,
      }),
    ).toBe(false);
  });
});

describe('slipNeedsBankCheck with the bank verdict (D-27)', () => {
  test('valid and not a duplicate: one tap, whatever the OCR says', () => {
    expect(slipNeedsBankCheck(facts({ verdict: 'valid' }))).toBe(false);
    expect(slipNeedsBankCheck(facts({ verdict: 'valid', check: null, recipient: null }))).toBe(
      false,
    );
    expect(
      slipNeedsBankCheck(facts({ verdict: 'valid', check: 'mismatch', recipient: 'mismatch' })),
    ).toBe(false);
  });

  test.each(SLIP_VERIFY_VERDICTS.filter((v) => v !== 'valid'))(
    'verdict %s needs the tick even when OCR says everything matches',
    (verdict) => {
      expect(slipNeedsBankCheck(facts({ verdict }))).toBe(true);
    },
  );

  test('every verdict with a local duplicate needs the tick', () => {
    for (const verdict of SLIP_VERIFY_VERDICTS) {
      expect(slipNeedsBankCheck(facts({ verdict, duplicate: true }))).toBe(true);
    }
  });

  test('verdict absent (verifier off): the OCR rule stays exactly as before', () => {
    expect(slipNeedsBankCheck(facts({ verdict: null }))).toBe(false);
    expect(slipNeedsBankCheck(facts({ verdict: undefined, check: 'mismatch' }))).toBe(true);
    expect(slipNeedsBankCheck(facts({ verdict: null, recipient: null }))).toBe(true);
  });

  test('no OCR check and no verdict needs the tick', () => {
    expect(slipNeedsBankCheck(facts({ check: null, recipient: null }))).toBe(true);
  });

  test('the slip list could not be read: a slip without any facts fails closed', () => {
    expect(
      slipNeedsBankCheck({ hasSlip: true, check: null, recipient: null, duplicate: false }),
    ).toBe(true);
  });

  test('no slip: no tick for any verdict', () => {
    expect(slipNeedsBankCheck({ ...NO_SLIP, verdict: 'valid' })).toBe(false);
    expect(slipNeedsBankCheck({ ...NO_SLIP, verdict: 'fraud' })).toBe(false);
  });
});
