import { describe, expect, test } from 'vitest';
import { shopPhoneOf, telHref } from './contact.ts';

describe('telHref', () => {
  test('keeps digits and a leading plus only', () => {
    expect(telHref('081-234 5678')).toBe('tel:0812345678');
    expect(telHref('+66 81 234 5678')).toBe('tel:+66812345678');
    expect(telHref('(02) 123 4567 ต่อ 9')).toBe('tel:0212345679');
  });
  test('a plus in the middle is dropped', () => {
    expect(telHref('081+2345678')).toBe('tel:0812345678');
  });
  test('nothing usable gives no link', () => {
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref('ไม่มี')).toBeNull();
    expect(telHref('12')).toBeNull();
  });
});

describe('shopPhoneOf', () => {
  test('is null until the API sends a number', () => {
    expect(shopPhoneOf(null)).toBeNull();
    expect(shopPhoneOf({})).toBeNull();
    expect(shopPhoneOf({ shopPhone: '  ' })).toBeNull();
    expect(shopPhoneOf({ shopPhone: ' 0812345678 ' })).toBe('0812345678');
  });
});
