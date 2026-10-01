import { ApiError } from './errors.ts';

export type HitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface GlobalLimiter {
  hit(): HitResult;
}

/**
 * One bucket for ALL callers (a constant key), as a ceiling on guessing that is spread over many
 * addresses. A fixed window held in memory: with one API instance (D-04) that is exact. The price
 * is that a flood from anywhere can use the bucket up for everybody until the window ends.
 */
export function createGlobalLimiter(options: {
  max: number;
  windowMs: number;
  now: () => Date;
}): GlobalLimiter {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    hit() {
      const now = options.now().getTime();
      if (now - windowStart >= options.windowMs) {
        windowStart = now;
        count = 0;
      }
      if (count >= options.max) {
        return { allowed: false, retryAfterMs: windowStart + options.windowMs - now };
      }
      count += 1;
      return { allowed: true };
    },
  };
}

/** A Fastify `onRequest` hook that answers 429 (the standard body) when the bucket is empty. */
export function globalRateLimitHook(limiter: GlobalLimiter) {
  return async (): Promise<void> => {
    const result = limiter.hit();
    if (!result.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', {
        retryAfterMs: result.retryAfterMs,
      });
    }
  };
}
