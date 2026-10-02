import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');

describe('the settings styles follow the design tokens and the touch rules', () => {
  test('no colour is typed in', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover', () => {
    expect(css).not.toContain(':hover');
  });

  test('a hub card is a tap target of at least 44 px', () => {
    expect(css).toMatch(/\.sset__card\s*{[^}]*min-height:\s*var\(--tap\)/);
  });

  test('on a phone the cards take one column', () => {
    expect(css).toMatch(/max-width:\s*719px\)\s*{[^}]*\.sset__cards/);
  });
});
