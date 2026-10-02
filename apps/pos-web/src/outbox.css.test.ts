import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./outbox.css', import.meta.url), 'utf8');

describe('the outbox styles follow the design tokens and the touch rules', () => {
  test('no colour is typed in', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover', () => {
    expect(css).not.toContain(':hover');
  });

  test('the badge link in the top bar is a tap target of at least 44 px', () => {
    expect(css).toMatch(/\.qbadge\s*{[^}]*var\(--tap\)/);
  });

  test('a waiting entry is told apart from a refused one by more than colour (dashed or solid border)', () => {
    expect(css).toMatch(/\.qcard\s*{[^}]*dashed/);
    expect(css).toMatch(/\.qcard--attention\s*{[^}]*solid/);
  });
});
