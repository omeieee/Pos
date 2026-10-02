import { describe, expect, test, vi } from 'vitest';
import { createActivity } from './activity.ts';

describe('activity (work that a page reload would lose)', () => {
  test('is idle until something begins, and busy until every one ends', () => {
    const activity = createActivity();
    expect(activity.isBusy()).toBe(false);
    const endA = activity.begin();
    const endB = activity.begin();
    expect(activity.isBusy()).toBe(true);
    endA();
    expect(activity.isBusy()).toBe(true);
    endB();
    expect(activity.isBusy()).toBe(false);
  });

  test('ending twice does not end somebody else’s work', () => {
    const activity = createActivity();
    const endA = activity.begin();
    activity.begin();
    endA();
    endA();
    expect(activity.isBusy()).toBe(true);
  });

  test('subscribers hear about changes', () => {
    const activity = createActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    const end = activity.begin();
    end();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
