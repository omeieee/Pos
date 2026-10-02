import { describe, expect, test } from 'vitest';
import type { OutboxEntry } from '../platform/localStore.ts';
import { uuid } from '../test-support/frames.ts';
import {
  dependentIds,
  ERROR_PARENT_MISSING,
  orderEntry,
  promptpayConfirmEntry,
  promptpayCreateEntry,
  purgeableIds,
  toQueueItems,
} from './outbox-model.ts';

const OWNER = { staffId: uuid(1), deviceId: uuid(3) };
const OTHER = { staffId: uuid(2), deviceId: uuid(3) };
const DAY = 86_400_000;

const order = (id: string, who = OWNER, at = 0): OutboxEntry =>
  orderEntry(
    id,
    {
      body: { channel: 'storefront', fulfillment: 'entrance_delivery', items: [] } as never,
      label: 'XA-01',
      lines: [],
      estimateSatang: 2500,
    },
    who,
    at,
  );
const create = (id: string, entryId: string, who = OWNER, at = 0) =>
  promptpayCreateEntry(
    id,
    {
      target: { entryId },
      qrAmountSatang: 2500,
      amountKind: 'estimate',
      qrTargetMasked: '******5678',
      label: 'XA-01',
    },
    who,
    at,
  );
const confirm = (id: string, createId: string, who = OWNER, at = 0) =>
  promptpayConfirmEntry(
    id,
    {
      target: { createEntryId: createId },
      qrAmountSatang: 2500,
      amountKind: 'estimate',
      label: 'XA-01',
    },
    who,
    at,
  );

describe('what waits behind what', () => {
  test('the confirm waits behind the create, which waits behind the order', () => {
    const rows = [order('o'), create('c', 'o'), confirm('k', 'c')];
    expect(dependentIds(rows, 'o').sort()).toEqual(['c', 'k']);
    expect(dependentIds(rows, 'c')).toEqual(['k']);
    expect(dependentIds(rows, 'k')).toEqual([]);
  });
});

describe('the queue as a person sees it', () => {
  test('a create and its confirm are ONE payment item, shown as waiting, never as paid', () => {
    const items = toQueueItems([order('o'), create('c', 'o'), confirm('k', 'c')]);
    expect(items.map((i) => i.kind)).toEqual(['order', 'payment']);
    expect(items[1]).toMatchObject({
      id: 'c',
      method: 'promptpay',
      state: 'queued',
      dependsOn: 'o',
      qrAmountSatang: 2500,
    });
  });

  test('a confirm whose create is gone without answering needs attention', () => {
    const items = toQueueItems([confirm('k', 'c')]);
    expect(items[0]).toMatchObject({
      state: 'attention',
      error: ERROR_PARENT_MISSING,
      canRetry: false,
    });
  });

  test('a create whose order entry is gone needs attention', () => {
    expect(toQueueItems([create('c', 'o'), confirm('k', 'c')])[0]).toMatchObject({
      state: 'attention',
      error: ERROR_PARENT_MISSING,
    });
  });
});

describe('purging entries nobody is coming for', () => {
  test('another person’s old order takes its create and confirm with it; the owner’s own stay', () => {
    const old = 20 * DAY;
    const rows = [
      order('o', OTHER),
      create('c', 'o', OTHER),
      confirm('k', 'c', OTHER),
      order('mine', OWNER),
      create('mc', 'mine', OWNER),
      confirm('mk', 'mc', OWNER),
    ];
    expect(purgeableIds(rows, OWNER, old).sort()).toEqual(['c', 'k', 'o']);
  });
});
