import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { cssVariableEntries } from './css.ts';
import { resolveTokens } from './resolve.ts';
import { baseTokens } from './tokens.ts';

const dark = resolveTokens('ipad', {}, 'dark').color;
const AA_TEXT = 4.5;
const AA_UI = 3;

describe('dark theme (kitchen display) meets WCAG 2.2 AA', () => {
  test.each([
    ['text on bg', dark.text, dark.bg],
    ['text on surface', dark.text, dark.surface],
    ['textMuted on bg', dark.textMuted, dark.bg],
    ['textMuted on surface', dark.textMuted, dark.surface],
    ['textMuted on surfaceSunken', dark.textMuted, dark.surfaceSunken],
    ['textInverse on text (light chip)', dark.textInverse, dark.text],
    ['onBrand on brand (primary button is unchanged)', dark.onBrand, dark.brand],
    ['brandText on brandSubtle', dark.brandText, dark.brandSubtle],
    ['accentText on accentSubtle', dark.accentText, dark.accentSubtle],
    ['warningText on warningSubtle', dark.warningText, dark.warningSubtle],
    ['infoText on infoSubtle', dark.infoText, dark.infoSubtle],
    ['successText on successSubtle', dark.successText, dark.successSubtle],
    ['dangerText on dangerSubtle', dark.dangerText, dark.dangerSubtle],
  ])('%s ≥ 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test.each([
    ['borderStrong on surface', dark.borderStrong, dark.surface],
    ['focus ring on bg', dark.focus, dark.bg],
    ['focus ring on surface', dark.focus, dark.surface],
  ])('%s ≥ 3:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('gradients keep white text readable on both ends', () => {
  test.each([
    ['brand', baseTokens.gradient.brand],
    ['success', baseTokens.gradient.success],
  ])('%s gradient', (_name, value) => {
    const stops = value.match(/#[0-9A-Fa-f]{6}/g) ?? [];
    expect(stops).toHaveLength(2);
    for (const stop of stops)
      expect(contrastRatio('#FFFFFF', stop)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('resolveTokens theme layer', () => {
  test('light is the default and equals an explicit light', () => {
    expect(resolveTokens('iphone')).toEqual(resolveTokens('iphone', {}, 'light'));
  });

  test('the dark theme changes neutrals but keeps the brand red and motion', () => {
    const light = resolveTokens('ipad');
    const night = resolveTokens('ipad', {}, 'dark');
    expect(night.color.bg).not.toBe(light.color.bg);
    expect(night.color.brand).toBe(light.color.brand);
    expect(night.motion).toEqual(light.motion);
  });

  test("the owner's shared brand colour wins over the theme", () => {
    const night = resolveTokens('ipad', { shared: { color: { brandText: '#112233' } } }, 'dark');
    expect(night.color.brandText).toBe('#112233');
  });
});

describe('glass.css only uses tokens that exist', () => {
  const css = readFileSync(new URL('./glass.css', import.meta.url), 'utf8');
  const known = new Set(cssVariableEntries(baseTokens).map(([name]) => name));
  // `--sds-d` is the per-element entrance delay, set by the screen, with a fallback.
  const used = [
    ...new Set([...css.matchAll(/var\((--sds-[a-z0-9-]+)/g)].map((m) => m[1] as string)),
  ];

  test('references at least the core tokens', () => {
    expect(used.length).toBeGreaterThan(30);
  });

  test.each(used.filter((name) => name !== '--sds-d'))('%s is defined', (name) => {
    expect(known.has(name)).toBe(true);
  });
});
