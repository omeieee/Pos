import { describe, expect, test } from 'vitest';
import {
  msUntilMinShown,
  SLIP_PROGRESS_GIVE_UP_MS,
  SLIP_PROGRESS_MIN_MS,
  SLIP_PROGRESS_SLOW_HINT_AFTER_MS,
  slipPollDelayMs,
  slipProgressPhase,
  slipResolved,
  slipSlowHintShown,
} from './slip-progress.ts';

const checking = { paymentStatus: 'awaiting_confirmation', slipCheck: 'checking' } as const;
const review = { paymentStatus: 'awaiting_confirmation', slipCheck: 'staff_review' } as const;
const paid = { paymentStatus: 'paid', slipCheck: 'staff_review' } as const;
const mismatch = { paymentStatus: 'awaiting_confirmation', slipCheck: 'amount_mismatch' } as const;
const waiting = { paymentStatus: 'awaiting_confirmation', slipCheck: 'verified_waiting' } as const;

describe('slipProgressPhase', () => {
  test('minimum display time is 5 seconds', () => {
    expect(SLIP_PROGRESS_MIN_MS).toBe(5000);
  });
  test('paid shows at once, with no hold', () => {
    expect(slipProgressPhase(0, paid)).toBe('paid');
    expect(slipProgressPhase(1, { paymentStatus: 'paid', slipCheck: 'verified_waiting' })).toBe(
      'paid',
    );
    expect(slipProgressPhase(4999, paid)).toBe('paid');
  });
  test('every other early answer is held until the minimum has passed', () => {
    for (const o of [review, mismatch, waiting]) {
      expect(slipProgressPhase(0, o)).toBe('checking');
      expect(slipProgressPhase(4999, o)).toBe('checking');
    }
    expect(slipProgressPhase(5000, review)).toBe('staff_review');
  });
  test('an amount mismatch and a pass awaiting the shop are named after the minimum', () => {
    expect(slipProgressPhase(5000, mismatch)).toBe('amount_mismatch');
    expect(slipProgressPhase(60_000, waiting)).toBe('verified_waiting');
  });
  test('paid wins over a staff_review check', () => {
    expect(slipProgressPhase(9000, paid)).toBe('paid');
  });
  test('still checking while no answer', () => {
    expect(slipProgressPhase(20_000, checking)).toBe('checking');
    expect(slipProgressPhase(20_000, null)).toBe('checking');
  });
  test('no answer after the give-up time is the neutral staff text', () => {
    expect(slipProgressPhase(SLIP_PROGRESS_GIVE_UP_MS - 1, checking)).toBe('checking');
    expect(slipProgressPhase(SLIP_PROGRESS_GIVE_UP_MS, checking)).toBe('staff_review');
  });
  test('only ever one of the known phases', () => {
    for (const e of [0, 5000, 60_000, 400_000]) {
      for (const o of [null, checking, review, paid, mismatch, waiting]) {
        expect([
          'checking',
          'paid',
          'staff_review',
          'amount_mismatch',
          'verified_waiting',
        ]).toContain(slipProgressPhase(e, o));
      }
    }
  });
});

describe('msUntilMinShown', () => {
  test('counts down to zero', () => {
    expect(msUntilMinShown(0)).toBe(5000);
    expect(msUntilMinShown(1200)).toBe(3800);
    expect(msUntilMinShown(9000)).toBe(0);
  });
});

describe('slipResolved', () => {
  test('paid or any finished check', () => {
    expect(slipResolved(null)).toBe(false);
    expect(slipResolved(checking)).toBe(false);
    expect(slipResolved(review)).toBe(true);
    expect(slipResolved(mismatch)).toBe(true);
    expect(slipResolved(waiting)).toBe(true);
    expect(slipResolved(paid)).toBe(true);
  });
});

describe('slipPollDelayMs', () => {
  test('about every 2 s while checking', () => {
    expect(slipPollDelayMs(0, checking, 0)).toBe(2000);
    expect(slipPollDelayMs(59_999, checking, 0)).toBe(2000);
  });
  test('hands over to the normal rate after 60 s', () => {
    expect(slipPollDelayMs(60_000, checking, 0)).toBeNull();
    expect(slipPollDelayMs(SLIP_PROGRESS_GIVE_UP_MS, checking, 0)).toBeNull();
  });
  test('normal rate when no check runs or it is answered', () => {
    expect(slipPollDelayMs(null, checking, 0)).toBeNull();
    expect(slipPollDelayMs(1000, review, 0)).toBeNull();
    expect(slipPollDelayMs(1000, paid, 0)).toBeNull();
    expect(slipPollDelayMs(1000, mismatch, 0)).toBeNull();
    expect(slipPollDelayMs(1000, waiting, 0)).toBeNull();
  });
  test('failures back off', () => {
    expect(slipPollDelayMs(1000, checking, 1)).toBe(4000);
    expect(slipPollDelayMs(1000, checking, 9)).toBe(30_000);
  });
});

describe('slipSlowHintShown', () => {
  test('only while checking, from the threshold on', () => {
    expect(SLIP_PROGRESS_SLOW_HINT_AFTER_MS).toBe(8000);
    expect(slipSlowHintShown(7999, 'checking')).toBe(false);
    expect(slipSlowHintShown(8000, 'checking')).toBe(true);
    expect(slipSlowHintShown(60_000, 'checking')).toBe(true);
  });
  test('never in a finished phase', () => {
    for (const phase of ['paid', 'staff_review', 'amount_mismatch', 'verified_waiting'] as const) {
      expect(slipSlowHintShown(20_000, phase)).toBe(false);
    }
  });
  test('the 5 s minimum display is unaffected: still checking, no hint, before the threshold', () => {
    expect(slipProgressPhase(SLIP_PROGRESS_MIN_MS, checking)).toBe('checking');
    expect(slipSlowHintShown(SLIP_PROGRESS_MIN_MS, 'checking')).toBe(false);
  });
});
