import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./menu-editor.css', import.meta.url), 'utf8');

describe('the menu editor styles follow the design tokens and the touch rules', () => {
  test('no colour is typed in', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover', () => {
    expect(css).not.toContain(':hover');
  });

  test('the sold-out switch is a tap target of at least 44 px', () => {
    expect(css).toMatch(/\.mswitch\s*{[^}]*min-height:\s*var\(--tap\)/);
  });

  test('an archived row is told apart from a live one by more than colour (dashed border)', () => {
    expect(css).toMatch(/\.mrow--archived\s*{[^}]*dashed/);
  });

  test('on a phone the actions take their own line', () => {
    expect(css).toMatch(/max-width:\s*719px\)\s*{[^}]*\.mrow__actions/);
  });
});
