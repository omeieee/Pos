import type { RealtimeFrame, SyncChange } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import {
  alertFrame,
  categoryFrame,
  groupFrame,
  itemFrame,
  optionFrame,
  orderFrame,
  paymentFrame,
  settingsFrame,
  uuid,
} from '../test-support/frames.ts';
import { createEntityStore } from './entity-store.ts';

describe('the rev rule', () => {
  test('a frame is applied only when its rev is newer than the stored one', () => {
    const store = createEntityStore();
    const id = uuid(1);
    expect(store.apply(orderFrame(id, 10, { status: 'new' }))).toBe(true);
    expect(store.apply(orderFrame(id, 9, { status: 'cancelled' }))).toBe(false);
    expect(store.apply(orderFrame(id, 10, { status: 'cancelled' }))).toBe(false);
    expect(store.getState().orders.get(id)?.status).toBe('new');
    expect(store.apply(orderFrame(id, 11, { status: 'preparing' }))).toBe(true);
    expect(store.getState().orders.get(id)?.status).toBe('preparing');
  });

  test('every family is keyed by its own id; the same id in two families does not collide', () => {
    const store = createEntityStore();
    const id = uuid(7);
    store.apply(categoryFrame(id, 5));
    store.apply(itemFrame(id, 6));
    store.apply(groupFrame(id, 7));
    store.apply(optionFrame(id, id, 8));
    store.apply(orderFrame(id, 9));
    store.apply(paymentFrame(id, id, 10));
    const state = store.getState();
    expect(state.categories.has(id)).toBe(true);
    expect(state.items.has(id)).toBe(true);
    expect(state.groups.has(id)).toBe(true);
    expect(state.options.has(id)).toBe(true);
    expect(state.orders.has(id)).toBe(true);
    expect(state.payments.has(id)).toBe(true);
  });

  test('an older frame of one entity does not block a newer frame of another', () => {
    const store = createEntityStore();
    store.apply(orderFrame(uuid(1), 50));
    expect(store.apply(orderFrame(uuid(2), 40))).toBe(true);
  });
});

describe('lastRev', () => {
  test('is the highest rev applied and starts at 0', () => {
    const store = createEntityStore();
    expect(store.getState().lastRev).toBe(0);
    store.apply(orderFrame(uuid(1), 12));
    store.apply(orderFrame(uuid(2), 7));
    expect(store.getState().lastRev).toBe(12);
  });

  test('a stale frame does not move it', () => {
    const store = createEntityStore();
    store.apply(orderFrame(uuid(1), 12));
    store.apply(orderFrame(uuid(1), 3));
    expect(store.getState().lastRev).toBe(12);
  });

  test('advance() moves it up only (the final nextSince of a catch-up)', () => {
    const store = createEntityStore();
    store.apply(orderFrame(uuid(1), 12));
    store.advance(30);
    expect(store.getState().lastRev).toBe(30);
    store.advance(20);
    expect(store.getState().lastRev).toBe(30);
  });
});

describe('modifier groups and their options', () => {
  test('a group is stored without its embedded options copy', () => {
    const store = createEntityStore();
    store.apply(groupFrame(uuid(1), 5, { options: [{ id: uuid(2), rev: 5 }] }));
    const group = store.getState().groups.get(uuid(1));
    expect(group).toBeDefined();
    expect(group && 'options' in group).toBe(false);
  });

  test('the embedded options are applied by their own rev', () => {
    const store = createEntityStore();
    store.apply(groupFrame(uuid(1), 5, { options: [{ id: uuid(2), rev: 5 }] }));
    expect(store.getState().options.get(uuid(2))?.rev).toBe(5);
  });

  test('a stale embedded option copy never overrides a newer option frame (sold-out toggle)', () => {
    const store = createEntityStore();
    store.apply(optionFrame(uuid(2), uuid(1), 20, { isAvailable: false }));
    // A group frame whose copy of the option was taken before the toggle.
    store.apply(groupFrame(uuid(1), 30, { options: [{ id: uuid(2), rev: 5, isAvailable: true }] }));
    expect(store.getState().options.get(uuid(2))?.isAvailable).toBe(false);
    expect(store.getState().options.get(uuid(2))?.rev).toBe(20);
  });
});

describe('settings', () => {
  test('are keyed by their setting key, with rev and version', () => {
    const store = createEntityStore();
    store.apply(settingsFrame('shop', 4, 2));
    const entry = store.getState().settings.get('shop');
    expect(entry).toMatchObject({ id: 'shop', rev: 4, version: 2 });
    expect(store.apply(settingsFrame('shop', 3, 9))).toBe(false);
  });

  test('a PromptPay frame marks the ID stale: promptpayRev moves with it', () => {
    const store = createEntityStore();
    expect(store.getState().promptpayRev).toBe(0);
    store.apply(settingsFrame('promptpay', 8, 1));
    expect(store.getState().promptpayRev).toBe(8);
    store.apply(settingsFrame('shop', 9, 1));
    expect(store.getState().promptpayRev).toBe(8);
    store.apply(settingsFrame('promptpay', 12, 2));
    expect(store.getState().promptpayRev).toBe(12);
  });
});

describe('alerts', () => {
  test('alert.new_order goes to listeners, never into the store, and never moves lastRev', () => {
    const store = createEntityStore();
    const heard = vi.fn();
    store.onAlert(heard);
    store.apply(orderFrame(uuid(1), 5));
    const before = store.getState();
    expect(store.apply(alertFrame(uuid(9)))).toBe(false);
    expect(store.getState()).toBe(before);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]?.[0]).toMatchObject({ type: 'alert.new_order', id: uuid(9) });
  });

  test('a listener can be removed, and a throwing listener does not stop the others', () => {
    const store = createEntityStore();
    const second = vi.fn();
    store.onAlert(() => {
      throw new Error('boom');
    });
    const off = store.onAlert(second);
    store.apply(alertFrame(uuid(1)));
    expect(second).toHaveBeenCalledTimes(1);
    off();
    store.apply(alertFrame(uuid(2)));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('notifications', () => {
  test('subscribers are told only when something changed', () => {
    const store = createEntityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.apply(orderFrame(uuid(1), 5));
    expect(listener).toHaveBeenCalledTimes(1);
    store.apply(orderFrame(uuid(1), 5));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('applyMany notifies once for a whole page and applies in order', () => {
    const store = createEntityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const frames: SyncChange[] = [
      orderFrame(uuid(1), 5, { status: 'new' }),
      orderFrame(uuid(1), 6, { status: 'preparing' }),
      orderFrame(uuid(2), 7),
    ];
    store.applyMany(frames);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().orders.get(uuid(1))?.status).toBe('preparing');
    expect(store.getState().lastRev).toBe(7);
  });

  test('a map that did not change keeps its identity (cheap selectors)', () => {
    const store = createEntityStore();
    store.apply(orderFrame(uuid(1), 5));
    const orders = store.getState().orders;
    store.apply(itemFrame(uuid(2), 6));
    expect(store.getState().orders).toBe(orders);
  });

  test('applyMany with only alerts still delivers them', () => {
    const store = createEntityStore();
    const heard = vi.fn();
    store.onAlert(heard);
    const frames: RealtimeFrame[] = [alertFrame(uuid(1)), alertFrame(uuid(2))];
    store.applyMany(frames);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('reset', () => {
  test('clears every family and lastRev, so the next catch-up starts from 0', () => {
    const store = createEntityStore();
    store.apply(orderFrame(uuid(1), 5));
    store.apply(settingsFrame('promptpay', 6, 1));
    store.reset();
    const state = store.getState();
    expect(state.orders.size).toBe(0);
    expect(state.settings.size).toBe(0);
    expect(state.lastRev).toBe(0);
    expect(state.promptpayRev).toBe(0);
    // Old revs are forgotten too: the same frame applies again.
    expect(store.apply(orderFrame(uuid(1), 5))).toBe(true);
  });

  test('keeps the alert listeners', () => {
    const store = createEntityStore();
    const heard = vi.fn();
    store.onAlert(heard);
    store.reset();
    store.apply(alertFrame(uuid(1)));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
