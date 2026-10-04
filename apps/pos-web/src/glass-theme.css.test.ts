import { readFileSync } from 'node:fs';
import { baseTokens, cssVariableEntries } from '@sds/ui';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./glass-theme.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

describe('the glass theme follows the same rules as the other stylesheets', () => {
  test('no colour is typed in: everything is a token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover: the counter is touch-first', () => {
    expect(css).not.toContain(':hover');
  });

  test('every token it uses exists', () => {
    const known = new Set(cssVariableEntries(baseTokens).map(([name]) => name));
    // --tap and --safe-* are set in styles.css, not by the tokens.
    const local = new Set(['--tap', '--safe-top', '--safe-right', '--safe-bottom', '--safe-left']);
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string))];
    expect(used.length).toBeGreaterThan(20);
    for (const name of used) expect(known.has(name) || local.has(name), name).toBe(true);
  });

  test('blur is kept off the dish tiles so scrolling stays smooth on an older iPad', () => {
    const dish = css.match(/\n\.dish\s*{[^}]*}/)?.[0] ?? '';
    expect(dish).not.toBe('');
    expect(dish).not.toContain('backdrop-filter');
  });

  test('a person who turns animation off gets the drifting orbs stopped', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*body::before[\s\S]*animation: none/);
  });

  test('it loads last, after the structural stylesheets, with the font and the shared keyframes', () => {
    expect(main.indexOf("import './glass-theme.css'")).toBeGreaterThan(
      main.indexOf("import './settings.css'"),
    );
    expect(main).toContain("'@fontsource-variable/anuphan/wght.css'");
    expect(main).toContain("'@sds/ui/glass.css'");
  });
});
