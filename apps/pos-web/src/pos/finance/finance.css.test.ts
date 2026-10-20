import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./finance.css', import.meta.url), 'utf8');

describe('the money pages follow the design tokens', () => {
  test('no colour is typed in', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover', () => {
    expect(css).not.toContain(':hover');
  });

  test('every token that is used exists in the token file', () => {
    const used = [...new Set([...css.matchAll(/var\((--sds-[a-z0-9-]+)/g)].map((m) => m[1]))];
    const tokens = readFileSync(
      new URL('../../../../../packages/ui/src/tokens.css', import.meta.url),
      'utf8',
    );
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) expect(tokens, name).toContain(`${name}:`);
  });

  test('a link in the sources list is a tap target of at least 44 px', () => {
    expect(css).toMatch(/\.fin-source a\s*{[^}]*min-height:\s*var\(--sds-touch-min\)/);
  });

  test('the page never scrolls sideways, and a wide table stacks on a phone', () => {
    expect(css).toMatch(/\.fin-page\s*{[^}]*overflow-x:\s*hidden/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.fin-table td::before/);
  });

  test('a struck-through row is struck by a class, so a word can always sit beside it', () => {
    expect(css).toMatch(/\.fin-struck\s*{[^}]*line-through/);
  });
});
