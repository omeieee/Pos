import { describe, expect, test } from 'vitest';
import { cssVariableEntries, toCssVariables } from './css.ts';
import { resolveTokens } from './resolve.ts';

describe('toCssVariables', () => {
  const tokens = resolveTokens('ipad');

  test('emits kebab-case custom properties for every token', () => {
    const css = toCssVariables(tokens);
    expect(css.startsWith(':root {\n')).toBe(true);
    expect(css).toContain(`  --sds-color-brand: ${tokens.color.brand};`);
    expect(css).toContain('  --sds-color-brand-hover: #A61E1E;');
    expect(css).toContain('  --sds-font-size-amount: 56px;');
    expect(css).toContain('  --sds-layout-menu-columns: 4;');
    expect(css).toContain('  --sds-touch-min: 48px;');
  });

  test('uses the given selector', () => {
    expect(toCssVariables(tokens, '[data-device="ipad"]')).toMatch(/^\[data-device="ipad"\] \{/);
  });

  test('one entry per leaf token, no duplicates', () => {
    const names = cssVariableEntries(tokens).map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^--sds-[a-z0-9-]+$/.test(n))).toBe(true);
  });
});
