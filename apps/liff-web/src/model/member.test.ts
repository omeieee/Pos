import {
  MEMBER_BUILDING_MAX,
  MEMBER_FULL_NAME_MAX,
  MEMBER_NICKNAME_MAX,
  memberInputSchema,
  normalizeThaiPhone,
} from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  EMPTY_MEMBER_FORM,
  isThaiPhone,
  MEMBER_LIMITS,
  memberFormOf,
  memberInput,
  memberProblems,
} from './member.ts';

const saved = { fullName: 'สมชาย ใจดี', nickname: 'ชาย', building: 'A', phone: '0812345678' };

describe('what the form sends', () => {
  test('nothing when nothing changed, so the order has no member part', () => {
    expect(memberInput(memberFormOf(saved), saved)).toBeUndefined();
    expect(memberInput(EMPTY_MEMBER_FORM, undefined)).toBeUndefined();
    expect(
      memberInput(EMPTY_MEMBER_FORM, {
        ...saved,
        fullName: null,
        nickname: null,
        building: null,
        phone: null,
      }),
    ).toBeUndefined();
  });

  test('only the fields that were filled in', () => {
    expect(memberInput({ ...EMPTY_MEMBER_FORM, nickname: ' ป้อม ' }, undefined)).toEqual({
      nickname: 'ป้อม',
    });
  });

  test('only the changed field when a saved profile is prefilled', () => {
    const form = { ...memberFormOf(saved), phone: '081 234 9999' };
    expect(memberInput(form, saved)).toEqual({ phone: '081 234 9999' });
  });

  test('an emptied field is sent as "" so the server clears it', () => {
    expect(memberInput({ ...memberFormOf(saved), nickname: '  ' }, saved)).toEqual({
      nickname: '',
    });
  });

  test('is accepted by the shared request schema', () => {
    const input = memberInput(
      { fullName: 'A', nickname: '', building: 'B', phone: '+66 81 234 5678' },
      saved,
    );
    const parsed = memberInputSchema.parse(input);
    expect(parsed.phone).toBe('0812345678');
    expect(parsed.nickname).toBeNull();
  });
});

describe('prefill', () => {
  test('an older server sends no profile: all empty', () => {
    expect(memberFormOf(undefined)).toEqual(EMPTY_MEMBER_FORM);
  });
  test('nulls become empty text', () => {
    expect(memberFormOf({ fullName: null, nickname: 'x', building: null, phone: null })).toEqual({
      ...EMPTY_MEMBER_FORM,
      nickname: 'x',
    });
  });
});

describe('client-side checks', () => {
  test('an empty phone is fine; a bad one is flagged', () => {
    expect(memberProblems(EMPTY_MEMBER_FORM)).toEqual([]);
    expect(memberProblems({ ...EMPTY_MEMBER_FORM, phone: '12345' })).toEqual(['phone']);
    expect(memberProblems({ ...EMPTY_MEMBER_FORM, phone: '081-234-5678' })).toEqual([]);
  });
  test('too-long text is flagged', () => {
    expect(memberProblems({ ...EMPTY_MEMBER_FORM, nickname: 'x'.repeat(41) })).toEqual([
      'nickname',
    ]);
  });
  test('mirrors the shared limits and phone rule', () => {
    expect(MEMBER_LIMITS).toEqual({
      fullName: MEMBER_FULL_NAME_MAX,
      nickname: MEMBER_NICKNAME_MAX,
      building: MEMBER_BUILDING_MAX,
    });
    for (const p of [
      '0812345678',
      '081 234 5678',
      '+66812345678',
      '66812345678',
      '021234567',
      '0212345678',
      '1234',
      '0112345678',
      '+6681234',
      'abc',
      '08-1234-5678',
    ])
      expect(isThaiPhone(p), p).toBe(normalizeThaiPhone(p) !== null);
  });
});
