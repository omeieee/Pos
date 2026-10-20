import { describe, expect, test } from 'vitest';
import {
  bpToPercentText,
  buildCommissionPatch,
  commissionFormFrom,
  parsePercentText,
  validateCommissionForm,
} from './commission-model.ts';

describe('a commission rate is basis points on the wire and a percent on screen', () => {
  test('basis points to percent text, exactly', () => {
    expect(bpToPercentText(null)).toBe('');
    expect(bpToPercentText(0)).toBe('0');
    expect(bpToPercentText(2500)).toBe('25');
    expect(bpToPercentText(2550)).toBe('25.5');
    expect(bpToPercentText(2505)).toBe('25.05');
    expect(bpToPercentText(10000)).toBe('100');
  });

  test('percent text to basis points, exactly (no floats)', () => {
    expect(parsePercentText('')).toEqual({ ok: true, bp: null });
    expect(parsePercentText('  ')).toEqual({ ok: true, bp: null });
    expect(parsePercentText('25')).toEqual({ ok: true, bp: 2500 });
    expect(parsePercentText('25.5')).toEqual({ ok: true, bp: 2550 });
    expect(parsePercentText('17.05')).toEqual({ ok: true, bp: 1705 });
    expect(parsePercentText('0')).toEqual({ ok: true, bp: 0 });
    expect(parsePercentText('100')).toEqual({ ok: true, bp: 10000 });
    expect(parsePercentText('1.1')).toEqual({ ok: true, bp: 110 });
  });

  test('anything else is refused', () => {
    for (const text of ['100.01', '101', '-1', '25.555', 'abc', '2 5', '25%', '1e2', '.5']) {
      expect(parsePercentText(text), text).toEqual({ ok: false });
    }
  });
});

describe('the commission form', () => {
  const loaded = { grabRateBp: 2500, linemanRateBp: null };

  test('starts from the saved rates; blank means not set', () => {
    expect(commissionFormFrom(loaded)).toEqual({ grab: '25', lineman: '' });
  });

  test('flags the fields that are not a rate', () => {
    expect(validateCommissionForm({ grab: '25', lineman: '' })).toEqual([]);
    expect(validateCommissionForm({ grab: 'x', lineman: '101' })).toEqual(['grab', 'lineman']);
  });

  test('a save sends only the rate that changed, with the version; nothing when none did', () => {
    expect(buildCommissionPatch(loaded, 3, { grab: '25', lineman: '' })).toBeNull();
    expect(buildCommissionPatch(loaded, 3, { grab: '25', lineman: '20' })).toEqual({
      expectedVersion: 3,
      linemanRateBp: 2000,
    });
    // Clearing a rate sends null: back to "rate not set".
    expect(buildCommissionPatch(loaded, 3, { grab: '', lineman: '' })).toEqual({
      expectedVersion: 3,
      grabRateBp: null,
    });
  });
});
