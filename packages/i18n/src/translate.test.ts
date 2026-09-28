import { describe, expect, test } from 'vitest';
import { en } from './en.ts';
import { th } from './th.ts';
import { DEFAULT_LOCALE, t, translator } from './translate.ts';

describe('catalogs', () => {
  test('th and en have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(th).sort());
  });

  test('every message is non-empty and uses the same placeholders in both locales', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(th) as (keyof typeof th)[]) {
      expect(th[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
      expect(placeholders(en[key]), key).toEqual(placeholders(th[key]));
    }
  });
});

describe('t', () => {
  test('Thai is the default locale', () => {
    expect(DEFAULT_LOCALE).toBe('th');
    expect(translator()('payment.confirm')).toBe('ยืนยันรับเงิน');
  });

  test('looks up English', () => {
    expect(t('en', 'payment.confirm')).toBe('Confirm payment');
  });

  test('interpolates params', () => {
    expect(t('th', 'pos.orderEntry.charge', { amount: '฿120.00' })).toBe('คิดเงิน ฿120.00');
    expect(t('en', 'line.cart.viewCart', { count: 3 })).toBe('View cart · 3 items');
  });

  test('leaves a missing param visible', () => {
    expect(t('en', 'pos.orderEntry.charge', {})).toBe('Charge {amount}');
  });
});
