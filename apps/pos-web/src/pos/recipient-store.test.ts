import type { RecipientDto } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { uuid } from '../test-support/frames.ts';
import { deliveryBuildings } from './delivery-model.ts';
import { createRecipientStore, type RecipientDeps } from './recipient-store.ts';

const saved = (n: number, name: string, building = 'B1'): RecipientDto => ({
  id: uuid(500 + n),
  building,
  recipientName: name,
  deliveryNote: null,
  lastOrderAt: null,
});

function setup() {
  const entities = createEntityStore();
  const list = vi.fn<RecipientDeps['api']['recipients']['list']>(async () => ({
    recipients: [saved(1, 'Fah'), saved(2, 'Nok', 'A1')],
  }));
  const delivery = vi.fn<RecipientDeps['api']['settings']['delivery']>(async () => ({
    value: { buildings: ['A1', 'Z9'] },
    version: 3,
    rev: 41,
    updatedAt: null,
  }));
  const store = createRecipientStore({
    api: { recipients: { list }, settings: { delivery } },
    entities,
  });
  return { store, entities, list, delivery };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the latest recipients', () => {
  test('refresh asks for the 8 most recent, with no search text', async () => {
    const { store, list } = setup();
    await store.refresh();
    expect(list).toHaveBeenCalledWith({ limit: 8 });
    expect(store.getState().recent.map((r) => r.recipientName)).toEqual(['Fah', 'Nok']);
  });

  test('a failed refresh keeps what was shown and says nothing loud', async () => {
    const { store, list } = setup();
    await store.refresh();
    list.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.refresh();
    expect(store.getState().recent).toHaveLength(2);
  });

  test('an older answer cannot replace a newer one', async () => {
    const { store, list } = setup();
    const slow = deferred<{ recipients: RecipientDto[] }>();
    list.mockReturnValueOnce(slow.promise);
    const first = store.refresh();
    list.mockResolvedValueOnce({ recipients: [saved(3, 'Newer')] });
    await store.refresh();
    slow.resolve({ recipients: [saved(4, 'Older')] });
    await first;
    expect(store.getState().recent.map((r) => r.recipientName)).toEqual(['Newer']);
  });
});

describe('searching by typing a name', () => {
  test('waits 250 ms after the last key, and sends only the last text', async () => {
    const { store, list } = setup();
    store.search('F');
    store.search('Fa');
    await vi.advanceTimersByTimeAsync(200);
    store.search('Fah');
    await vi.advanceTimersByTimeAsync(249);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ q: 'Fah', limit: 8 });
  });

  test('shows the matches apart from the latest list', async () => {
    const { store, list } = setup();
    await store.refresh();
    list.mockResolvedValueOnce({ recipients: [saved(5, 'Fahsai')] });
    store.search('Fah');
    await vi.advanceTimersByTimeAsync(250);
    expect(store.getState().matches?.map((r) => r.recipientName)).toEqual(['Fahsai']);
    expect(store.getState().recent).toHaveLength(2);
  });

  test('an empty or blank text drops the matches and sends nothing', async () => {
    const { store, list } = setup();
    list.mockResolvedValueOnce({ recipients: [saved(5, 'Fahsai')] });
    store.search('Fah');
    await vi.advanceTimersByTimeAsync(250);
    store.search('   ');
    expect(store.getState().matches).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('clearing the text cancels a search that has not been sent yet', async () => {
    const { store, list } = setup();
    store.search('Fah');
    store.search('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).not.toHaveBeenCalled();
  });

  test('an older answer cannot overwrite the matches of a newer text', async () => {
    const { store, list } = setup();
    const slow = deferred<{ recipients: RecipientDto[] }>();
    list.mockReturnValueOnce(slow.promise);
    store.search('Fa');
    await vi.advanceTimersByTimeAsync(250);
    list.mockResolvedValueOnce({ recipients: [saved(6, 'Fahsai')] });
    store.search('Fahs');
    await vi.advanceTimersByTimeAsync(250);
    slow.resolve({ recipients: [saved(7, 'Faye')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().matches?.map((r) => r.recipientName)).toEqual(['Fahsai']);
  });

  test('a failed search leaves no matches and no message holding the typed text', async () => {
    const { store, list } = setup();
    list.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    store.search('SECRET');
    await vi.advanceTimersByTimeAsync(250);
    expect(store.getState().matches).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain('SECRET');
  });
});

describe('the buildings', () => {
  test('are not fetched when the feed already has them', async () => {
    const { store, entities, delivery } = setup();
    entities.apply({
      type: 'settings.updated',
      id: 'delivery',
      rev: 9,
      version: 1,
      data: { buildings: ['A1'] },
    });
    await store.ensureBuildings();
    expect(delivery).not.toHaveBeenCalled();
  });

  test('are read once when the feed has not brought them, and then come from the store', async () => {
    const { store, entities, delivery } = setup();
    await store.ensureBuildings();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(deliveryBuildings(entities.getState().settings)).toEqual(['A1', 'Z9']);
    await store.ensureBuildings();
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  test('a later frame from the feed wins over the one read', async () => {
    const { store, entities } = setup();
    await store.ensureBuildings();
    entities.apply({
      type: 'settings.updated',
      id: 'delivery',
      rev: 42,
      version: 4,
      data: { buildings: ['A1', 'Z9', 'Q1'] },
    });
    expect(deliveryBuildings(entities.getState().settings)).toEqual(['A1', 'Z9', 'Q1']);
  });

  test('a failed read is tried again next time', async () => {
    const { store, delivery } = setup();
    delivery.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.ensureBuildings();
    await store.ensureBuildings();
    expect(delivery).toHaveBeenCalledTimes(2);
  });
});

describe('reset (sign-out)', () => {
  test('forgets the names of the person who left and cancels a search to be sent', async () => {
    const { store, list } = setup();
    await store.refresh();
    store.search('Fah');
    store.reset();
    expect(store.getState()).toMatchObject({ recent: [], matches: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('a late answer cannot bring names back for the next person', async () => {
    const { store, list } = setup();
    const late = deferred<{ recipients: RecipientDto[] }>();
    list.mockReturnValueOnce(late.promise);
    const pending = store.refresh();
    store.reset();
    late.resolve({ recipients: [saved(8, 'Late')] });
    await pending;
    expect(store.getState().recent).toEqual([]);
  });
});
