import { describe, expect, test } from 'vitest';
import type { MergeFacts } from './order-merge.ts';
import { allocateSlip, type SlipCandidate } from './slip-allocation.ts';

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  customerId: 'c1',
  channel: 'line',
  status: 'new',
  businessDate: '2026-10-24',
  deliveryBuilding: 'B1',
  recipientName: 'Fah',
  payments: [{ status: 'pending', hasSlip: false }],
  ...over,
});
const cand = (
  orderId: string,
  dueSatang: number | bigint,
  over: Partial<MergeFacts> = {},
): SlipCandidate => ({ orderId, dueSatang, facts: facts(over) });

const review = (orderId: string) => ({ kind: 'review', orderId, autoConfirm: false });

describe('allocateSlip (D-40): the amount picks the order, it never confirms one', () => {
  test('12 + 50 baht, slip 50: the 50 baht order, not the oldest', () => {
    expect(allocateSlip(5000, [cand('a', 1200), cand('b', 5000)])).toEqual({
      kind: 'single',
      orderId: 'b',
    });
  });

  test('12 + 50 baht, slip 12: the 12 baht order', () => {
    expect(allocateSlip(1200, [cand('a', 1200), cand('b', 5000)])).toEqual({
      kind: 'single',
      orderId: 'a',
    });
  });

  test('12 + 50 baht, slip 62: merge into the oldest', () => {
    expect(allocateSlip(6200, [cand('a', 1200), cand('b', 5000)])).toEqual({
      kind: 'merge',
      targetId: 'a',
      sourceIds: ['b'],
    });
  });

  test('two 50 baht orders, slip 50: the oldest', () => {
    expect(allocateSlip(5000, [cand('a', 5000), cand('b', 5000)])).toEqual({
      kind: 'single',
      orderId: 'a',
    });
  });

  test('two 50 baht orders, slip 100: merge', () => {
    expect(allocateSlip(10000, [cand('a', 5000), cand('b', 5000)])).toEqual({
      kind: 'merge',
      targetId: 'a',
      sourceIds: ['b'],
    });
  });

  test('when a single exact match and the full sum both match, the single wins', () => {
    // a=40 + b=60 is the full sum (100) and c=100 is an exact match: choose c, merge nothing.
    expect(allocateSlip(10000, [cand('a', 4000), cand('b', 6000), cand('c', 10000)])).toEqual({
      kind: 'single',
      orderId: 'c',
    });
  });

  test('merge needs the sum of ALL orders eligible with the oldest; a partial sum is review', () => {
    const three = [cand('a', 1200), cand('b', 5000), cand('c', 3000)];
    expect(allocateSlip(6200, three)).toEqual(review('a'));
    expect(allocateSlip(9200, three)).toEqual({
      kind: 'merge',
      targetId: 'a',
      sourceIds: ['b', 'c'],
    });
  });

  test('orders that are not eligible with the oldest are left out of the sum', () => {
    const otherBuilding = cand('b', 5000, { deliveryBuilding: 'B2' });
    expect(allocateSlip(6200, [cand('a', 1200), otherBuilding])).toEqual(review('a'));
    expect(allocateSlip(6200, [cand('a', 1200), otherBuilding, cand('c', 5000)])).toEqual({
      kind: 'merge',
      targetId: 'a',
      sourceIds: ['c'],
    });
  });

  test('an order that already has a claim or slip is not merged', () => {
    const claimed = cand('b', 5000, { payments: [{ status: 'claimed', hasSlip: true }] });
    expect(allocateSlip(6200, [cand('a', 1200), claimed])).toEqual(review('a'));
  });

  test('null, zero, negative, fractional, unmatched or unsafe amounts go to review on the oldest', () => {
    const list = [cand('a', 1200), cand('b', 5000)];
    expect(allocateSlip(null, list)).toEqual(review('a'));
    expect(allocateSlip(0, list)).toEqual(review('a'));
    expect(allocateSlip(7777, list)).toEqual(review('a'));
    expect(allocateSlip(-5000, list)).toEqual(review('a'));
    expect(allocateSlip(50.5, list)).toEqual(review('a'));
    expect(allocateSlip(2n ** 70n, list)).toEqual(review('a'));
  });

  test('bigint amounts and dues work like numbers', () => {
    expect(allocateSlip(5000n, [cand('a', 1200n), cand('b', 5000n)])).toEqual({
      kind: 'single',
      orderId: 'b',
    });
    expect(allocateSlip(6200n, [cand('a', 1200), cand('b', 5000n)])).toMatchObject({
      kind: 'merge',
    });
  });

  test('one candidate: exact is single, otherwise review', () => {
    expect(allocateSlip(1200, [cand('a', 1200)])).toEqual({ kind: 'single', orderId: 'a' });
    expect(allocateSlip(1300, [cand('a', 1200)])).toEqual(review('a'));
  });

  test('refuses an empty list', () => {
    expect(() => allocateSlip(100, [])).toThrow(RangeError);
  });
});
