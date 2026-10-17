import { describe, expect, test } from 'vitest';
import { contrastRatio, relativeLuminance } from './contrast.ts';
import { resolveTokens } from './resolve.ts';

const light = resolveTokens('ipad');
const dark = resolveTokens('ipad', {}, 'dark');
const series = (t: typeof light) => [
  t.chart.series1,
  t.chart.series2,
  t.chart.series3,
  t.chart.series4,
  t.chart.series5,
];
const heat = (t: typeof light) => [t.chart.heat1, t.chart.heat2, t.chart.heat3, t.chart.heat4];

describe('chart tokens (data-viz rules)', () => {
  test('the series slots are the validated categorical order, light and dark', () => {
    // Validated with the data-viz palette script: adjacent colour-blind separation >= 8, normal
    // vision >= 15, in the lightness band, in both themes. Do not reorder or swap a slot.
    expect(series(light)).toEqual(['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4']);
    expect(series(dark)).toEqual(['#3987E5', '#D95926', '#199E70', '#C98500', '#D55181']);
  });

  test('on dark every series colour reaches 3:1 against the dark surface', () => {
    for (const c of series(dark)) {
      expect(contrastRatio(c, dark.color.surface), c).toBeGreaterThanOrEqual(3);
    }
  });

  test('the heat ramp is one hue that grows stronger: darker on light, lighter on dark', () => {
    const lum = (t: typeof light) => heat(t).map(relativeLuminance);
    expect(lum(light)).toEqual([...lum(light)].sort((a, b) => b - a));
    expect(lum(dark)).toEqual([...lum(dark)].sort((a, b) => a - b));
    expect(new Set(lum(light)).size).toBe(4);
    expect(new Set(lum(dark)).size).toBe(4);
  });

  test('even the faintest heat step stands out from its surface (2:1)', () => {
    expect(contrastRatio(light.chart.heat1, light.color.surface)).toBeGreaterThanOrEqual(2);
    expect(contrastRatio(dark.chart.heat1, dark.color.surface)).toBeGreaterThanOrEqual(2);
  });

  test('the two themes share the structure: every light token has a dark one', () => {
    expect(Object.keys(dark.chart)).toEqual(Object.keys(light.chart));
  });
});
