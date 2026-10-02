import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { alertFrame, orderFrame, uuid } from '../test-support/frames.ts';
import {
  createNewOrderAlarm,
  MAX_REMINDERS,
  REMINDER_EVERY_MS,
  remindersDue,
} from './new-order-alarm.ts';

const T0 = Date.parse('2030-01-01T05:00:00.000Z');
const MIN = 60_000;
const placed = (minutesAgo: number, now = T0) => new Date(now - minutesAgo * MIN).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('which orders are due another reminder', () => {
  const order = (status: 'new' | 'preparing', minutesAgo: number) => ({
    id: uuid(1),
    status,
    placedAt: placed(minutesAgo),
  });

  test('none before two minutes; one at two, two at four, and so on', () => {
    expect(remindersDue(order('new', 1), T0)).toBe(0);
    expect(remindersDue(order('new', 2), T0)).toBe(1);
    expect(remindersDue(order('new', 3), T0)).toBe(1);
    expect(remindersDue(order('new', 4), T0)).toBe(2);
  });

  test('stops at the cap, and a stale order (older than the window) gets none', () => {
    expect(REMINDER_EVERY_MS).toBe(2 * MIN);
    expect(remindersDue(order('new', (MAX_REMINDERS + 0.5) * 2), T0)).toBe(MAX_REMINDERS);
    expect(remindersDue(order('new', (MAX_REMINDERS + 1) * 2), T0)).toBe(0);
    expect(remindersDue(order('new', 600), T0)).toBe(0);
  });

  test('only an order that is still new is waiting for someone', () => {
    expect(remindersDue(order('preparing', 5), T0)).toBe(0);
  });
});

function setup(options: { deviceId?: string | null; played?: boolean } = {}) {
  const entities = createEntityStore();
  const play = vi.fn<(kind: 'newOrder' | 'reminder') => boolean>(() => options.played ?? true);
  const alarm = createNewOrderAlarm({
    entities,
    sound: { play },
    deviceId: () => options.deviceId ?? null,
  });
  const stop = alarm.start();
  return { entities, play, stop };
}

describe('the chime for a new order', () => {
  test('plays when an order arrives', () => {
    const { entities, play } = setup();
    entities.apply(alertFrame(uuid(1)));
    expect(play).toHaveBeenCalledWith('newOrder');
  });

  test('is silent for an order that this very device rang up', () => {
    const device = uuid(77);
    const { entities, play } = setup({ deviceId: device });
    const frame = alertFrame(uuid(1));
    entities.apply({ ...frame, data: { ...frame.data, createdOnDeviceId: device } });
    expect(play).not.toHaveBeenCalled();
    // Another device's order still rings.
    const other = alertFrame(uuid(2));
    entities.apply({ ...other, data: { ...other.data, createdOnDeviceId: uuid(78) } });
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('a burst of orders is one chime, not a pile of overlapping ones', () => {
    const { entities, play } = setup();
    entities.apply(alertFrame(uuid(1)));
    entities.apply(alertFrame(uuid(2)));
    entities.apply(alertFrame(uuid(3)));
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('stopping the alarm stops the chime', () => {
    const { entities, play, stop } = setup();
    stop();
    entities.apply(alertFrame(uuid(1)));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('the reminder for an order that stays new', () => {
  test('a second sound after two minutes, and again every two minutes while it is still new', async () => {
    const { entities, play } = setup();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(0) }));
    entities.apply(alertFrame(uuid(1)));
    expect(play.mock.calls.map((c) => c[0])).toEqual(['newOrder']);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * MIN + 10_000);
    expect(play.mock.calls.map((c) => c[0])).toEqual(['newOrder', 'reminder']);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(play.mock.calls.map((c) => c[0])).toEqual(['newOrder', 'reminder', 'reminder']);
  });

  test('stops as soon as someone starts the order', async () => {
    const { entities, play } = setup();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(0) }));
    await vi.advanceTimersByTimeAsync(2 * MIN + 10_000);
    expect(play).toHaveBeenCalledTimes(1);
    entities.apply(orderFrame(uuid(1), 2, { status: 'preparing', placedAt: placed(2) }));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('stops after the cap even if nobody touches it', async () => {
    const { entities, play } = setup();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(0) }));
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(play).toHaveBeenCalledTimes(MAX_REMINDERS);
  });

  test('an order that arrived while the device was offline is still reminded about (no alert needed)', async () => {
    const { entities, play } = setup();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(3) }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play.mock.calls.map((c) => c[0])).toEqual(['reminder']);
  });

  test('missed reminders are not replayed one after another', async () => {
    const { entities, play } = setup();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(7) }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('while the sound is off nothing is used up: turning it on rings for the order that is waiting', async () => {
    let on = false;
    const entities = createEntityStore();
    const play = vi.fn(() => on);
    createNewOrderAlarm({ entities, sound: { play }, deviceId: () => null }).start();
    entities.apply(orderFrame(uuid(1), 1, { status: 'new', placedAt: placed(3) }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(play).toHaveBeenCalled();
    play.mockClear();
    on = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play).toHaveBeenCalledWith('reminder');
  });

  test('one reminder sound for several waiting orders, not one each', async () => {
    const { entities, play } = setup();
    for (const n of [1, 2, 3]) {
      entities.apply(orderFrame(uuid(n), n, { status: 'new', placedAt: placed(3) }));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play).toHaveBeenCalledTimes(1);
  });
});
