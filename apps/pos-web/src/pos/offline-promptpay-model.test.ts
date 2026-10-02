import { promptpayPayload } from '@sds/promptpay';
import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  CLOCK_BACK_TOLERANCE_MS,
  OFFLINE_QR_MAX_AGE_MS,
  offlineQr,
  PROMPTPAY_CACHE_SCHEMA,
  readSavedPromptpay,
  type SavedPromptpay,
  savedIdRefusal,
} from './offline-promptpay-model.ts';

const NOW = Date.parse('2030-10-15T05:00:00Z');
const saved = (over: Partial<SavedPromptpay> = {}): SavedPromptpay => ({
  v: PROMPTPAY_CACHE_SCHEMA,
  staffId: 'staff-1',
  savedAt: NOW - 60_000,
  rev: 7,
  stale: false,
  target: { idType: 'phone', idValue: '0812345678' },
  ...over,
});

describe('the age limit', () => {
  test('is 24 hours: still fine at the limit, refused one millisecond after', () => {
    expect(OFFLINE_QR_MAX_AGE_MS).toBe(24 * 3600_000);
    expect(savedIdRefusal(saved({ savedAt: NOW - OFFLINE_QR_MAX_AGE_MS }), NOW)).toBeNull();
    expect(savedIdRefusal(saved({ savedAt: NOW - OFFLINE_QR_MAX_AGE_MS - 1 }), NOW)).toBe('tooOld');
  });

  test('a clock turned back past the tolerance counts as too old; a small adjustment does not', () => {
    expect(savedIdRefusal(saved({ savedAt: NOW + CLOCK_BACK_TOLERANCE_MS }), NOW)).toBeNull();
    expect(savedIdRefusal(saved({ savedAt: NOW + CLOCK_BACK_TOLERANCE_MS + 1 }), NOW)).toBe(
      'tooOld',
    );
  });

  test('a stale mark or no record refuses whatever the age', () => {
    expect(savedIdRefusal(saved({ stale: true }), NOW)).toBe('stale');
    expect(savedIdRefusal(null, NOW)).toBe('none');
  });
});

describe('the QR for an amount', () => {
  test('is the shared payload for the saved ID and exactly that amount, with the last four digits', () => {
    const result = offlineQr(saved(), NOW, 7550);
    expect(result).toEqual({
      ok: true,
      payload: promptpayPayload({ idType: 'phone', idValue: '0812345678' }, satang(7550)),
      last4: '5678',
      savedAt: NOW - 60_000,
    });
  });

  test.each([0, -100, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, 1_000_000_000, null])(
    'no QR for the amount %s',
    (amount) => {
      expect(offlineQr(saved(), NOW, amount)).toEqual({ ok: false, reason: 'badAmount' });
    },
  );

  test('a refusal carries a reason only: nothing of the ID', () => {
    for (const result of [
      offlineQr(null, NOW, 100),
      offlineQr(saved({ stale: true }), NOW, 100),
      offlineQr(saved({ savedAt: 0 }), NOW, 100),
      offlineQr(saved(), NOW, 0),
    ]) {
      expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
      expect(JSON.stringify(result)).not.toContain('0812345678');
    }
  });
});

describe('reading the saved record', () => {
  test('accepts a good one and drops a damaged, wrong-schema or truncated one', () => {
    expect(readSavedPromptpay(saved())).toEqual(saved());
    expect(readSavedPromptpay({ ...saved(), v: PROMPTPAY_CACHE_SCHEMA + 1 })).toBeNull();
    expect(
      readSavedPromptpay({ ...saved(), target: { idType: 'phone', idValue: '12' } }),
    ).toBeNull();
    expect(readSavedPromptpay({ ...saved(), staffId: '' })).toBeNull();
    expect(readSavedPromptpay('0812345678')).toBeNull();
    expect(readSavedPromptpay(undefined)).toBeNull();
  });
});
