import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const kitchen = readFileSync(new URL('./kitchen.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

/** The rule of one selector: its declarations, to look for a property in. */
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*{([^}]*)}`).exec(kitchen)?.[1] ?? '';
};

describe('the kitchen view follows the design tokens and the touch rules', () => {
  test('is loaded by the app', () => {
    expect(entry).toContain("'./kitchen.css'");
  });

  test('no colour is typed into the stylesheet: every colour is a design token', () => {
    expect(kitchen).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(kitchen).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover: every control works by touch alone', () => {
    expect(kitchen).not.toContain(':hover');
  });

  test('the controls are tap targets of at least 44 px (the tap floor)', () => {
    for (const selector of ['.ksound__state', '.ksound__btn', '.kready__toggle', '.kready__row']) {
      expect(rule(selector), selector).toContain('var(--tap)');
    }
    // The one-tap moves are the primary touch size, never below the floor.
    expect(rule('.kcard__move')).toMatch(
      /min-height:\s*var\(--sds-touch-primary,\s*var\(--tap\)\)/,
    );
  });

  test('a long press on the sound control selects no text and opens no iOS callout', () => {
    const declarations = rule('.ksound');
    expect(declarations).toContain('-webkit-touch-callout: none');
    expect(declarations).toContain('-webkit-user-select: none');
    expect(declarations).toContain('user-select: none');
  });

  test('the page keeps clear of the home indicator (safe-area inset at the bottom)', () => {
    expect(rule('.kitchen')).toContain('var(--safe-bottom)');
  });

  test('the late and the slow steps are drawn with tokens, and the late one is thicker (not colour alone)', () => {
    expect(rule('.kcard--warn')).toContain('var(--sds-color-warning');
    expect(rule('.kcard--late')).toContain('var(--sds-color-danger');
    expect(rule('.kcard--late')).toMatch(/border:\s*4px/);
  });

  test('the tickets are one column on a phone and a grid beyond', () => {
    expect(rule('.ktickets')).toContain('grid-template-columns: repeat(auto-fill');
    expect(kitchen).toMatch(
      /@media \(max-width: 719px\)[\s\S]*\.ktickets\s*{[^}]*grid-template-columns:\s*1fr/,
    );
  });
});
