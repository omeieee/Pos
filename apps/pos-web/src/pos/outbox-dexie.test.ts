import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NewOrderInput } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createStore } from '../lib/store.ts';
import { createDexieLocalStore } from '../platform/dexieStore.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createOutboxStore, type OutboxDeps } from './outbox-store.ts';

const body: NewOrderInput = {
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Fah ตัวอย่าง',
  items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
};

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
};

function boot(name: string, create: OutboxDeps['api']['orders']['create'], online: boolean) {
  const life = createFakeLifecycle({ online });
  const outbox = createOutboxStore({
    api: {
      orders: { create },
      payments: {
        create: async () => {
          throw new Error('not expected');
        },
      },
    },
    entities: createEntityStore(),
    auth: createStore({
      phase: 'signedIn' as const,
      session: { staff: { id: uuid(1) } },
      device: { id: uuid(3) },
    }),
    lifecycle: life.lifecycle,
    connection: createStore({ status: 'online' as const }),
    // Opened again under the same name each time: a reload of the page.
    localStore: () => createDexieLocalStore(name),
  });
  const unbind = outbox.bind();
  return { outbox, life, unbind };
}

describe('the outbox over IndexedDB (Dexie)', () => {
  test('an order saved offline survives a reload and is replayed once, under the same id and body', async () => {
    const first = boot(
      'outbox-test-a',
      async () => {
        throw new ApiClientError('NETWORK');
      },
      false,
    );
    await settle();
    const saved = await first.outbox.enqueueOrder({
      clientRequestId: uuid(10),
      body,
      lines: [],
      estimateSatang: 2500,
    });
    expect(saved).toMatchObject({ ok: true, id: uuid(10) });
    first.unbind();

    const create = vi.fn<OutboxDeps['api']['orders']['create']>(async (_input, options) => ({
      order: orderDto(uuid(900), 500, { orderNo: 'S-031' }),
      replay: false,
      clientRequestId: options?.clientRequestId ?? '',
    }));
    const second = boot('outbox-test-a', create, true);
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(body, { clientRequestId: uuid(10) });
    expect(second.outbox.getState().items).toHaveLength(0);

    // Nothing is left behind to be sent a second time.
    second.unbind();
    const third = boot('outbox-test-a', create, true);
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(third.outbox.getState().items).toHaveLength(0);
  });

  test('the provisional counter keeps counting after a reload', async () => {
    const offline = async () => {
      throw new ApiClientError('NETWORK');
    };
    const a = boot('outbox-test-b', offline, false);
    await settle();
    const one = await a.outbox.enqueueOrder({
      clientRequestId: uuid(20),
      body,
      lines: [],
      estimateSatang: null,
    });
    a.unbind();
    const b = boot('outbox-test-b', offline, false);
    await settle();
    const two = await b.outbox.enqueueOrder({
      clientRequestId: uuid(21),
      body,
      lines: [],
      estimateSatang: null,
    });
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(one.label.slice(-2)).toBe('01');
      expect(two.label.slice(-2)).toBe('02');
      expect(one.label.slice(0, 2)).toBe(two.label.slice(0, 2));
    }
  });
});
