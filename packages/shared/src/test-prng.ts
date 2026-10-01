/**
 * Seeded pseudo-random numbers for property-style tests. `fast-check` is not a dependency
 * (new dependencies are not allowed), so the money tests loop over a few thousand cases drawn
 * from this deterministic generator. The generator is test-only: it never touches money.
 */
export type Rng = () => number;

/** mulberry32: a small, well-known 32-bit generator; the same seed gives the same cases. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly drawn integer in [lo, hi], both included. Both bounds must be safe integers. */
export function randomInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
