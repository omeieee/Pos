import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { KEEPALIVE_INTERVAL_MS, startSessionKeepalive } from './keepalive.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2030-01-01T05:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const MIN = 60_000;

function setup(options: { visible?: boolean; ping?: () => Promise<unknown> } = {}) {
  const ping = vi.fn(options.ping ?? (async () => undefined));
  const life = createFakeLifecycle({ visible: options.visible ?? true });
  const stop = startSessionKeepalive({ ping, lifecycle: life.lifecycle });
  return { ping, life, stop };
}

describe('the session keepalive', () => {
  test('is every ten minutes by default: well inside the two-hour idle limit', () => {
    expect(KEEPALIVE_INTERVAL_MS).toBe(10 * MIN);
  });

  test('pings once every interval while the page is in front, and not before', async () => {
    const { ping } = setup();
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  test('does not ping while the page is hidden', async () => {
    const { ping, life } = setup();
    life.hide();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(ping).not.toHaveBeenCalled();
  });

  test('pings as soon as the page returns if the last ping is older than the interval', async () => {
    const { ping, life } = setup();
    life.hide();
    await vi.advanceTimersByTimeAsync(45 * MIN);
    life.show();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('does not ping on return when the last ping is recent', async () => {
    const { ping, life } = setup();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(ping).toHaveBeenCalledTimes(1);
    life.hide();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    life.show();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('a failing ping is ignored: the API client already signs out on a 401, anything else is retried next time', async () => {
    const { ping } = setup({
      ping: async () => {
        throw new Error('offline');
      },
    });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  test('stopping ends the timer and the visibility listener', async () => {
    const { ping, life, stop } = setup();
    stop();
    expect(life.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(ping).not.toHaveBeenCalled();
  });

  test('one ping at a time: a slow answer is not stacked up', async () => {
    let finish!: () => void;
    const { ping } = setup({
      ping: () =>
        new Promise((resolve) => {
          finish = () => resolve(undefined);
        }),
    });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(ping).toHaveBeenCalledTimes(1);
    finish();
  });
});
