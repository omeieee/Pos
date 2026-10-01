import { describe, expect, test } from 'vitest';
import { ApiError } from './errors.ts';
import { createGlobalLimiter, globalRateLimitHook } from './rate-limit.ts';

function clock(start = 0) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createGlobalLimiter', () => {
  test('allows `max` hits per window, whoever makes them, then refuses with the time left', () => {
    const c = clock();
    const limiter = createGlobalLimiter({ max: 3, windowMs: 60_000, now: c.now });
    expect([limiter.hit(), limiter.hit(), limiter.hit()].map((r) => r.allowed)).toEqual([
      true,
      true,
      true,
    ]);
    c.advance(10_000);
    expect(limiter.hit()).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  test('opens again after the window and counts afresh', () => {
    const c = clock();
    const limiter = createGlobalLimiter({ max: 1, windowMs: 1000, now: c.now });
    expect(limiter.hit().allowed).toBe(true);
    expect(limiter.hit().allowed).toBe(false);
    c.advance(1000);
    expect(limiter.hit().allowed).toBe(true);
    expect(limiter.hit().allowed).toBe(false);
  });

  test('refused hits do not push the window out', () => {
    const c = clock();
    const limiter = createGlobalLimiter({ max: 1, windowMs: 1000, now: c.now });
    limiter.hit();
    for (let i = 0; i < 5; i++) {
      c.advance(100);
      limiter.hit();
    }
    c.advance(500);
    expect(limiter.hit().allowed).toBe(true);
  });
});

describe('globalRateLimitHook', () => {
  test('throws the standard 429 body when the bucket is empty', async () => {
    const hook = globalRateLimitHook(
      createGlobalLimiter({ max: 1, windowMs: 60_000, now: () => new Date(0) }),
    );
    await hook();
    const error = await hook().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterMs: 60_000 },
    });
  });
});
