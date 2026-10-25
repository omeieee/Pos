/**
 * Spring motion as a CSS easing, for the design lab. A damped spring is sampled from rest to its
 * target and written as a CSS `linear()` easing together with the time it takes to settle, so a
 * CSS transition or `element.animate` moves like the owner's reference (a spring of stiffness 280,
 * damping 32, mass 1) without a motion library. Pure: no DOM.
 */

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** The reference's spring for movement: it settles in about 0.45 s with no visible overshoot. */
export const SMOOTH: Spring = { stiffness: 280, damping: 32, mass: 1 };
/** A livelier spring for things that pop in (the ready bell, the sold-out stamp): about 13% overshoot. */
export const POP: Spring = { stiffness: 420, damping: 22, mass: 1 };

/** Position (0 at rest, 1 at the target) of a spring released from rest, `t` seconds later. */
export function springAt(spring: Spring, t: number): number {
  const { stiffness: k, damping: c, mass: m } = spring;
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

export interface SpringEasing {
  /** A CSS `linear(...)` easing. */
  easing: string;
  /** Milliseconds until the spring stays within `epsilon` of its target. */
  durationMs: number;
}

/** Longest spring the lab draws; the slowest preview (0.25x) of `SMOOTH` takes about 0.95 s. */
const MAX_MS = 4000;

/**
 * The spring as a `linear()` easing. `speed` slows it the way the reference's speed switch does
 * (stiffness x speed, damping x the square root of speed): the same shape, played slower.
 */
export function springEasing(
  spring: Spring,
  speed = 1,
  epsilon = 0.001,
  points = 40,
): SpringEasing {
  const scaled: Spring = {
    stiffness: spring.stiffness * speed,
    damping: spring.damping * Math.sqrt(speed),
    mass: spring.mass,
  };
  let settled = 1;
  for (let ms = 0; ms <= MAX_MS; ms += 1) {
    if (Math.abs(1 - springAt(scaled, ms / 1000)) >= epsilon) settled = ms + 1;
  }
  const stops: string[] = [];
  for (let i = 0; i <= points; i += 1) {
    const value = i === points ? 1 : springAt(scaled, (settled * i) / points / 1000);
    stops.push(String(Math.round(value * 10000) / 10000));
  }
  return { easing: `linear(${stops.join(', ')})`, durationMs: settled };
}
