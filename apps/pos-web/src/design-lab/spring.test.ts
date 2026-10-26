import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { POP, SMOOTH, springAt, springEasing } from './spring.ts';

const stops = (easing: string) =>
  easing
    .replace(/^linear\(|\)$/g, '')
    .split(',')
    .map(Number);

describe('springs as CSS easings', () => {
  test('a spring starts at rest and ends on its target', () => {
    expect(springAt(SMOOTH, 0)).toBeCloseTo(0, 6);
    expect(springAt(SMOOTH, 2)).toBeCloseTo(1, 6);
    const values = stops(springEasing(SMOOTH).easing);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
  });

  test("the reference's spring settles in under half a second with no visible overshoot", () => {
    const { easing, durationMs } = springEasing(SMOOTH);
    expect(durationMs).toBeGreaterThan(350);
    expect(durationMs).toBeLessThan(550);
    expect(Math.max(...stops(easing))).toBeLessThanOrEqual(1.001);
  });

  test('the pop spring overshoots, so a bell or a stamp lands with a bounce', () => {
    expect(Math.max(...stops(springEasing(POP).easing))).toBeGreaterThan(1.05);
  });

  test('a slower speed keeps the shape and takes longer (a quarter speed is about twice as long)', () => {
    const full = springEasing(SMOOTH, 1).durationMs;
    const quarter = springEasing(SMOOTH, 0.25).durationMs;
    expect(quarter / full).toBeGreaterThan(1.9);
    expect(quarter / full).toBeLessThan(2.1);
  });
});

describe('the design lab stays out of the app', () => {
  test('the app entry does not load it', () => {
    const entry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(entry).not.toContain('design-lab');
  });

  test('its stylesheet types colours only in the token section at the top', () => {
    const css = readFileSync(new URL('./design-lab.css', import.meta.url), 'utf8');
    const rest = css.slice(css.indexOf('2. Page, frame and backdrop'));
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rest).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });
});
