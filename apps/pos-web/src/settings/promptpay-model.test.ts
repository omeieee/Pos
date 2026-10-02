import type { PaymentDto } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  buildPromptpayInput,
  normalizeIdText,
  openPromptpayCount,
  previewMasked,
  readPromptpayDraft,
} from './promptpay-model.ts';

// Made-up IDs only: a 0 and nine digits, 13 digits, 15 digits. Never a real account.
const PHONE = '0800001234';
const NATIONAL = '1234567890123';
const EWALLET = '123456789012345';

describe('what is typed', () => {
  test('spaces and hyphens people type between digits are dropped', () => {
    expect(normalizeIdText(' 080-000 1234 ')).toBe(PHONE);
    expect(normalizeIdText('1-2345-67890-12-3')).toBe(NATIONAL);
  });

  test('each kind has its own shape: 0 and 9 digits, 13 digits, 15 digits', () => {
    expect(readPromptpayDraft({ idType: 'phone', idValue: PHONE })).toEqual({
      ok: true,
      id: { idType: 'phone', idValue: PHONE },
    });
    expect(readPromptpayDraft({ idType: 'national_id', idValue: NATIONAL }).ok).toBe(true);
    expect(readPromptpayDraft({ idType: 'ewallet', idValue: EWALLET }).ok).toBe(true);
    // The wrong kind for the digits typed.
    expect(readPromptpayDraft({ idType: 'phone', idValue: NATIONAL }).ok).toBe(false);
    expect(readPromptpayDraft({ idType: 'phone', idValue: '1800001234' }).ok).toBe(false);
    expect(readPromptpayDraft({ idType: 'national_id', idValue: PHONE }).ok).toBe(false);
    expect(readPromptpayDraft({ idType: 'phone', idValue: '' }).ok).toBe(false);
    expect(readPromptpayDraft({ idType: 'phone', idValue: '08000012ab' }).ok).toBe(false);
  });

  test('typed separators are accepted but the saved ID is digits only', () => {
    expect(readPromptpayDraft({ idType: 'phone', idValue: '080-000-1234' })).toEqual({
      ok: true,
      id: { idType: 'phone', idValue: PHONE },
    });
  });
});

describe('what the person is shown before confirming', () => {
  test('only the masked form of the new ID', () => {
    const read = readPromptpayDraft({ idType: 'phone', idValue: PHONE });
    if (!read.ok) throw new Error('expected a valid draft');
    expect(previewMasked(read.id)).toBe('******1234');
    expect(previewMasked(read.id)).not.toContain('0800');
  });
});

describe('the save', () => {
  test('carries the version the screen saw (0: never saved) and the digits', () => {
    const read = readPromptpayDraft({ idType: 'phone', idValue: PHONE });
    if (!read.ok) throw new Error('expected a valid draft');
    expect(buildPromptpayInput(4, read.id)).toEqual({
      expectedVersion: 4,
      idType: 'phone',
      idValue: PHONE,
    });
    expect(buildPromptpayInput(0, read.id).expectedVersion).toBe(0);
  });
});

describe('PromptPay payments still waiting', () => {
  const payment = (id: string, method: string, status: string) =>
    [id, { id, method, status } as unknown as PaymentDto] as const;

  test('counts pending and claimed PromptPay payments only, as the server does', () => {
    const rows = new Map([
      payment('a', 'promptpay', 'pending'),
      payment('b', 'promptpay', 'claimed'),
      payment('c', 'promptpay', 'confirmed'),
      payment('d', 'promptpay', 'cancelled'),
      payment('e', 'cash', 'pending'),
      payment('f', 'gov_copay', 'claimed'),
    ]);
    expect(openPromptpayCount(rows)).toBe(2);
    expect(openPromptpayCount(new Map())).toBe(0);
  });
});
