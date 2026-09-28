import { describe, expect, test } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { baseTokens } from './tokens.ts';

const c = baseTokens.color;
const AA_TEXT = 4.5;
const AA_UI = 3;

describe('contrastRatio', () => {
  test('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('default palette meets WCAG 2.2 AA', () => {
  test.each([
    ['onBrand on brand (primary button)', c.onBrand, c.brand],
    ['onBrand on brandHover', c.onBrand, c.brandHover],
    ['onSuccess on success (confirm payment)', c.onSuccess, c.success],
    ['brandText on brandSubtle', c.brandText, c.brandSubtle],
    ['brandText on surface', c.brandText, c.surface],
    ['accentText on surface', c.accentText, c.surface],
    ['accentText on accentSubtle', c.accentText, c.accentSubtle],
    ['text on bg', c.text, c.bg],
    ['textMuted on bg', c.textMuted, c.bg],
    ['textMuted on surfaceSunken', c.textMuted, c.surfaceSunken],
    ['textInverse on text (dark chip)', c.textInverse, c.text],
    ['warningText on warningSubtle (ยังไม่ชำระ)', c.warningText, c.warningSubtle],
    ['infoText on infoSubtle (รอตรวจสอบ)', c.infoText, c.infoSubtle],
    ['successText on successSubtle (ชำระแล้ว)', c.successText, c.successSubtle],
    ['dangerText on dangerSubtle', c.dangerText, c.dangerSubtle],
  ])('%s ≥ 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each([
    ['borderStrong on surface (inputs)', c.borderStrong, c.surface],
    ['focus ring on bg', c.focus, c.bg],
    ['focus ring on surface', c.focus, c.surface],
  ])('%s ≥ 3:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_UI);
  });

  test('orange accent is decorative only: it fails as text on white', () => {
    expect(contrastRatio(c.accent, c.surface)).toBeLessThan(AA_TEXT);
  });
});
