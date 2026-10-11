import type { SlipCheck, SlipRecipientCheck } from '@sds/shared';
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
