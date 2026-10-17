import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./reports.css', import.meta.url), 'utf8');

describe('the overview styles follow the design tokens and the data-viz rules', () => {
  test('no colour is typed in', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('nothing depends on hover', () => {
    expect(css).not.toContain(':hover');
  });

  test('every chart colour is a chart token, and every one that is used exists', () => {
    const used = [...new Set([...css.matchAll(/var\((--sds-chart-[a-z0-9]+)/g)].map((m) => m[1]))];
    expect(used.sort()).toEqual([
      '--sds-chart-heat1',
      '--sds-chart-heat2',
      '--sds-chart-heat3',
      '--sds-chart-heat4',
      '--sds-chart-series1',
      '--sds-chart-series2',
      '--sds-chart-series3',
      '--sds-chart-series4',
      '--sds-chart-series5',
    ]);
    const tokens = readFileSync(
      new URL('../../../packages/ui/src/tokens.css', import.meta.url),
      'utf8',
    );
    for (const name of used) expect(tokens, name).toContain(`${name}:`);
  });

  test('a swatch and a stack segment exist for each of the five channel slots', () => {
    for (const slot of [1, 2, 3, 4, 5]) {
      expect(css).toContain(`.rpt-swatch--${slot}`);
      expect(css).toContain(`.rpt-stack__seg--${slot}`);
    }
  });

  test('a gap of 2 px separates the stacked segments and the heat cells', () => {
    expect(css).toMatch(/\.rpt-stack\s*{[^}]*gap:\s*2px/);
    expect(css).toMatch(/\.rpt-heat\s*{[^}]*border-spacing:\s*2px/);
  });

  test('the "show as a table" row is a tap target of at least 44 px', () => {
    expect(css).toMatch(/\.rpt-details > summary\s*{[^}]*min-height:\s*var\(--sds-touch-min\)/);
  });

  test('on the lighter heat steps the text is dark ink, on the darker steps it is the inverse ink', () => {
    expect(css).toMatch(/\.rpt-heat__1\s*{[^}]*color:\s*var\(--sds-color-text\)/);
    expect(css).toMatch(/\.rpt-heat__2\s*{[^}]*color:\s*var\(--sds-color-text\)/);
    expect(css).toMatch(/\.rpt-heat__3\s*{[^}]*color:\s*var\(--sds-color-text-inverse\)/);
    expect(css).toMatch(/\.rpt-heat__4\s*{[^}]*color:\s*var\(--sds-color-text-inverse\)/);
  });

  test('the heat grid scrolls inside its card, never the page', () => {
    expect(css).toMatch(/\.rpt-heat-wrap\s*{[^}]*overflow-x:\s*auto/);
  });

  test('a coloured heat cell out-ranks the plain cell rule (td.rpt-heat__N beats .rpt-heat td)', () => {
    for (const level of [1, 2, 3, 4]) expect(css).toContain(`.rpt-heat td.rpt-heat__${level}`);
  });
});
