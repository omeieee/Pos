import { describe, expect, test } from 'vitest';
import {
  createLiffHealth,
  LIFF_ALERT_EVERY_MS,
  LIFF_REJECTION_THRESHOLD,
  LIFF_REJECTION_WINDOW_MS,
} from './liff-health.ts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 4, 5, 0, 0) + ms);

describe('createLiffHealth', () => {
  test('a few refusals are normal; repeated ones raise one alert, then none for an hour', () => {
    const health = createLiffHealth();
    for (let i = 1; i < LIFF_REJECTION_THRESHOLD; i++) {
      expect(health.rejected(at(i * 1000))).toMatchObject({ overThreshold: false, alert: false });
    }
    expect(health.rejected(at(10_000))).toMatchObject({ overThreshold: true, alert: true });
    expect(health.rejected(at(11_000))).toMatchObject({ overThreshold: true, alert: false });
    // Still failing 59 minutes in: quiet. An hour on, a new burst speaks again.
    for (let i = 0; i < LIFF_REJECTION_THRESHOLD; i++) {
      expect(health.rejected(at(LIFF_ALERT_EVERY_MS - 60_000 + i)).alert).toBe(false);
    }
    expect(health.rejected(at(LIFF_ALERT_EVERY_MS + 11_000 + 1)).alert).toBe(true);
  });

  test('refusals far apart do not add up, and a success clears the streak', () => {
    const health = createLiffHealth();
    for (let i = 0; i < 10; i++) {
      expect(health.rejected(at(i * (LIFF_REJECTION_WINDOW_MS + 1000))).overThreshold).toBe(false);
    }
    const quick = createLiffHealth();
    for (let i = 0; i < LIFF_REJECTION_THRESHOLD - 1; i++) quick.rejected(at(i));
    quick.accepted();
    expect(quick.rejected(at(100)).count).toBe(1);
  });
});
