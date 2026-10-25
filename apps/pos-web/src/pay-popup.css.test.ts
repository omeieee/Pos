import { readFileSync } from 'node:fs';
import { baseTokens, cssVariableEntries } from '@sds/ui';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./pay-popup.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

describe('the payment pop-up stylesheet follows the design tokens and the touch rules', () => {
  test('is loaded by the app', () => {
    expect(entry).toContain("'./pay-popup.css'");
  });

  test('no colour is typed in, and nothing depends on hover', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(css).not.toContain(':hover');
  });

  test('every token it uses exists', () => {
    const known = new Set(cssVariableEntries(baseTokens).map(([name]) => name));
    const local = new Set(['--tap', '--safe-top', '--safe-right', '--safe-bottom', '--safe-left']);
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string))];
    expect(used.length).toBeGreaterThan(10);
    for (const name of used) expect(known.has(name) || local.has(name), name).toBe(true);
  });

  test('the buttons are at least the tap floor and the sheet keeps clear of the home indicator', () => {
    expect(css).toMatch(/\.ppop__actions \.g-btn\s*{[^}]*var\(--tap\)/);
    expect(css).toContain('var(--safe-bottom)');
  });
});
