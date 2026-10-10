import { describe, expect, test } from 'vitest';
import {
  cleanText,
  memberInputSchema,
  mergeMember,
  NO_MEMBER_PROFILE,
  normalizeThaiPhone,
} from './member.ts';

describe('cleanText', () => {
  test('strips control and zero-width characters and collapses spaces', () => {
    expect(cleanText('  สมชาย\u0000\t ใจดี​\n')).toBe('สมชาย ใจดี');
  });
});

describe('normalizeThaiPhone', () => {
  test.each([
    ['0812345678', '0812345678'],
    ['081-234-5678', '0812345678'],
    ['081 234 5678', '0812345678'],
    ['+66812345678', '0812345678'],
    ['66812345678', '0812345678'],
    ['02 123 4567', '021234567'],
    ['(053) 123456', '053123456'],
    ['053123456', '053123456'],
  ])('%s', (input, expected) => {
    expect(normalizeThaiPhone(input)).toBe(expected);
  });

  test.each(['', 'abc', '081234567', '08123456789', '0112345678', '1812345678', '+1 555 123 4567'])(
    'refuses %s',
    (input) => {
      expect(normalizeThaiPhone(input)).toBeNull();
    },
  );
});

describe('memberInputSchema', () => {
  test('all fields are optional', () => {
    expect(memberInputSchema.parse({})).toEqual({});
  });

  test('cleans text, normalises the phone and turns empty into null', () => {
    expect(
      memberInputSchema.parse({
        fullName: ' สมชาย\u0007 ใจดี ',
        nickname: '',
        building: 'B1',
        phone: '081-234-5678',
      }),
    ).toEqual({ fullName: 'สมชาย ใจดี', nickname: null, building: 'B1', phone: '0812345678' });
  });

  test('enforces the length limits after cleaning', () => {
    expect(memberInputSchema.safeParse({ nickname: 'ก'.repeat(41) }).success).toBe(false);
    expect(memberInputSchema.safeParse({ nickname: 'ก'.repeat(40) }).success).toBe(true);
    expect(memberInputSchema.safeParse({ fullName: 'ก'.repeat(101) }).success).toBe(false);
    expect(memberInputSchema.safeParse({ building: 'x'.repeat(61) }).success).toBe(false);
  });

  test('refuses a bad phone and an unknown field', () => {
    expect(memberInputSchema.safeParse({ phone: '12345' }).success).toBe(false);
    expect(memberInputSchema.safeParse({ email: 'a@b.c' }).success).toBe(false);
  });
});

describe('mergeMember', () => {
  const saved = { fullName: 'A', nickname: 'B', building: 'C', phone: '0812345678' };

  test('a field left out keeps the saved value; null clears it; a value replaces it', () => {
    expect(mergeMember(saved, { nickname: null, building: 'D' })).toEqual({
      fullName: 'A',
      nickname: null,
      building: 'D',
      phone: '0812345678',
    });
    expect(mergeMember(NO_MEMBER_PROFILE, {})).toEqual(NO_MEMBER_PROFILE);
  });
});
