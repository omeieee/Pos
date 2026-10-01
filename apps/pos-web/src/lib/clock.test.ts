import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hasActiveLock, lockSecondsLeft } from '../auth/pin-pad.ts';
import { subscribeTicks } from './clock.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T05:00:00Z'));
});
afterEach(() => vi.useRealTimers());

/**
 * What PinScreen does on every render: read the time, ask whether any lock is still running,
 * and run the timer only while one is. This is the scenario from the review: a lock expires
 * between two ticks, or the page sleeps past it.
 */
function simulateScreen(lockedUntil: Record<string, number>) {
  const log = { ticking: false, secondsLeft: -1, renders: 0 };
  let stop: (() => void) | null = null;
  const render = () => {
    log.renders += 1;
    const now = Date.now();
    log.secondsLeft = lockSecondsLeft(lockedUntil.staff, now);
    const lock = hasActiveLock(lockedUntil, now);
    if (lock && !stop) stop = subscribeTicks(1000, render);
    if (!lock && stop) {
      stop();
      stop = null;
    }
    log.ticking = stop !== null;
  };
  render();
  return log;
}

describe('lock countdown', () => {
  test('counts down while a lock runs, then re-enables the pad and stops the timer', () => {
    const log = simulateScreen({ staff: Date.now() + 3000 });
    expect(log).toMatchObject({ ticking: true, secondsLeft: 3 });
    vi.advanceTimersByTime(1000);
    expect(log.secondsLeft).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(log).toMatchObject({ ticking: false, secondsLeft: 0 });
    const rendersAtStop = log.renders;
    vi.advanceTimersByTime(10_000);
    expect(log.renders).toBe(rendersAtStop);
  });

  test('a page that slept past the lock (iOS background) comes back unlocked', () => {
    const log = simulateScreen({ staff: Date.now() + 5000 });
    expect(log.secondsLeft).toBe(5);
    // Timers do not fire while the page is suspended; one fires when it wakes, 60 s later.
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersToNextTimer();
    expect(log).toMatchObject({ ticking: false, secondsLeft: 0 });
  });

  test('no lock, no timer', () => {
    const log = simulateScreen({});
    expect(log).toMatchObject({ ticking: false, secondsLeft: 0, renders: 1 });
  });
});

describe('hasActiveLock', () => {
  test('is judged at the time given, not at some earlier time', () => {
    const until = { a: 10_000 };
    expect(hasActiveLock(until, 9_000)).toBe(true);
    expect(hasActiveLock(until, 10_000)).toBe(false);
    expect(hasActiveLock({}, 0)).toBe(false);
  });
});
