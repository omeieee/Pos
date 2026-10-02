/**
 * The first catch-up (`GET /v1/sync?since=0`) is bounded: orders and payments of the current
 * business day, every open order and every order with a pending or claimed payment, and nothing
 * else of the history. A device that resumes (`since > 0`) still gets every later change, including
 * a change to an old order. Real app, PGlite; the clock is moved so that some orders are "old".
 *
 * Not proven here: real-Postgres query plans on a large history, and two devices racing on one
 * session at the millisecond level.
 */
import {
  type OrderDto,
  orderDtoSchema,
  type PaymentDto,
  paymentDtoSchema,
  type SyncChange,
  type SyncResponse,
  syncResponseSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager', { id: string; pin: string }>;
let tokens: { owner: string; cashier: string; manager: string };

// Test identifier only, not a real PromptPay ID.
const PHONE = '0899994321';
const DAY0 = '2028-03-30T03:00:00.000Z'; // 10:00 in Bangkok, business day 2028-03-30
const DAY1 = '2028-03-31T03:00:00.000Z'; // the next business day: "today"

/** Old closed and paid (cash); old and open; old and open; old, closed, payment still pending. */
const old = {} as Record<'closedPaid' | 'open' | 'openToClose' | 'closedPendingPay', OrderDto>;
const today = {} as Record<'closedPaid' | 'openPromptpay', OrderDto>;
const pay = {} as Record<'oldPaid' | 'oldPending' | 'todayPaid' | 'todayPending', PaymentDto>;

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | undefined,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function ok(res: ReturnType<typeof call>, expected = 200) {
  const r = await res;
  if (r.statusCode !== expected)
    throw new Error(`expected ${expected}, got ${r.statusCode}: ${r.body}`);
  return r.json() as Record<string, unknown>;
}

async function sync(token: string, query = ''): Promise<SyncResponse> {
  const res = await call('GET', `/v1/sync${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return syncResponseSchema.parse(res.json());
}

/** Every page from `since`, the way the client walks them. */
async function walk(token: string, limit = 500, since = 0) {
  const changes: SyncChange[] = [];
  const pages: SyncResponse[] = [];
  let cursor = since;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await sync(token, `?since=${cursor}&limit=${limit}`);
    pages.push(page);
    changes.push(...page.changes);
    if (!page.hasMore) break;
    cursor = page.nextSince;
  }
  return { changes, pages };
}

const keyOf = (c: SyncChange) => `${c.type}${'kind' in c ? `:${c.kind}` : ''}:${c.id}`;
const orderIdsOf = (changes: SyncChange[]) =>
  changes.flatMap((c) => (c.type === 'order.upserted' ? [c.id] : []));
const paymentIdsOf = (changes: SyncChange[]) =>
  changes.flatMap((c) => (c.type === 'payment.upserted' ? [c.id] : []));
const isHistoryFamily = (c: SyncChange) =>
  c.type === 'order.upserted' || c.type === 'payment.upserted';

async function place(token: string): Promise<OrderDto> {
  const body = await ok(
    call('POST', '/v1/orders', token, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
    }),
    201,
  );
  return orderDtoSchema.parse(body);
}

async function startPayment(token: string, orderId: string, method: 'cash' | 'promptpay') {
  const body = await ok(
    call('POST', `/v1/orders/${orderId}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method,
      ...(method === 'cash' ? { tendered: 10000 } : {}),
    }),
    201,
  );
  return paymentDtoSchema.parse(body.payment);
}

const moveOrder = (token: string, id: string, to: 'ready' | 'completed') =>
  ok(call('POST', `/v1/orders/${id}/transition`, token, { to }));

async function complete(token: string, id: string) {
  await moveOrder(token, id, 'ready');
  await moveOrder(token, id, 'completed');
}

async function signIn() {
  const cashier = await h.pinSession(device.token, staff.cashier.id, staff.cashier.pin);
  const manager = await h.pinSession(device.token, staff.manager.id, staff.manager.pin);
  h.clock.advanceSeconds(90); // a TOTP code is good once: the next one is a new 30-second step
  return { cashier, manager, owner: await h.ownerSession(owner) };
}

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  owner = await h.newOwner();
  device = await h.newDevice();
  for (const role of ['cashier', 'manager'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }

  // ---- the old business day ----
  h.clock.set(DAY0);
  const stepped = await h.steppedUpOwner(owner);
  await ok(
    call('PATCH', '/v1/settings/promptpay', stepped, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    }),
  );
  const d0 = await signIn();

  old.closedPaid = await place(d0.cashier);
  pay.oldPaid = await startPayment(d0.cashier, old.closedPaid.id, 'cash');
  await complete(d0.cashier, old.closedPaid.id);

  old.open = await place(d0.cashier);
  old.openToClose = await place(d0.cashier);

  old.closedPendingPay = await place(d0.cashier);
  pay.oldPending = await startPayment(d0.cashier, old.closedPendingPay.id, 'promptpay');
  // A closed order that still has a pending payment: the rules would not let the routes get here.
  await h.client.query("update orders set status = 'completed' where id = $1", [
    old.closedPendingPay.id,
  ]);

  // ---- the current business day ----
  h.clock.set(DAY1);
  tokens = await signIn();
  today.closedPaid = await place(tokens.cashier);
  pay.todayPaid = await startPayment(tokens.cashier, today.closedPaid.id, 'cash');
  await complete(tokens.cashier, today.closedPaid.id);
  today.openPromptpay = await place(tokens.cashier);
  pay.todayPending = await startPayment(tokens.cashier, today.openPromptpay.id, 'promptpay');
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('a fresh device (since=0)', () => {
  test('gets today, every open order and every order with an open payment; not the closed history', async () => {
    const { changes } = await walk(tokens.owner);
    expect(new Set(orderIdsOf(changes))).toEqual(
      new Set([
        today.closedPaid.id, // the current business day
        today.openPromptpay.id,
        old.open.id, // still open, though from yesterday
        old.openToClose.id,
        old.closedPendingPay.id, // closed, but its payment is pending
      ]),
    );
    expect(orderIdsOf(changes)).not.toContain(old.closedPaid.id);
    // The payments of those orders, and not the paid-up old order's.
    expect(new Set(paymentIdsOf(changes))).toEqual(
      new Set([pay.todayPaid.id, pay.todayPending.id, pay.oldPending.id]),
    );
    // An order comes with its lines.
    const open = changes.find((c) => c.type === 'order.upserted' && c.id === old.open.id);
    expect(open?.type === 'order.upserted' && open.data.items).toHaveLength(1);
  });

  test('every role that may see orders gets the same bounded set', async () => {
    const kitchenToken = await h.pinSession(
      device.token,
      (await h.newStaff('kitchen', '4821')).id,
      '4821',
    );
    const kitchen = await walk(kitchenToken);
    expect(orderIdsOf(kitchen.changes)).not.toContain(old.closedPaid.id);
    expect(orderIdsOf(kitchen.changes)).toContain(old.open.id);
  });

  test('menu, settings and the other tables stay complete', async () => {
    const bounded = await walk(tokens.owner, 500, 0);
    // The unbounded baseline: a device that resumes at since=1 (the first rev itself is not compared).
    const full = await walk(tokens.owner, 500, 1);
    const rest = (changes: SyncChange[]) =>
      changes
        .filter((c) => !isHistoryFamily(c) && c.rev > 1)
        .map(keyOf)
        .sort();
    expect(rest(bounded.changes)).toEqual(rest(full.changes));
    expect(rest(bounded.changes).length).toBeGreaterThan(5);
    // ...and the baseline does carry the closed history that the bounded one leaves out.
    expect(orderIdsOf(full.changes)).toContain(old.closedPaid.id);
    expect(paymentIdsOf(full.changes)).toContain(pay.oldPaid.id);
  });

  test('paging the bounded set: pages add up to the unpaged result, hasMore is exact, the cursor moves', async () => {
    const whole = await walk(tokens.owner, 500);
    expect(whole.pages).toHaveLength(1);
    const paged = await walk(tokens.owner, 3);
    expect(paged.changes.map(keyOf)).toEqual(whole.changes.map(keyOf));
    expect(orderIdsOf(paged.changes)).not.toContain(old.closedPaid.id);
    expect(paymentIdsOf(paged.changes)).not.toContain(pay.oldPaid.id);
    expect(paged.pages.length).toBeGreaterThan(3);
    let last = 0;
    for (const [i, page] of paged.pages.entries()) {
      expect(page.changes.length).toBeLessThanOrEqual(3);
      expect(page.nextSince).toBeGreaterThan(last);
      last = page.nextSince;
      expect(page.hasMore).toBe(i < paged.pages.length - 1);
      expect(page.serverRev).toBeGreaterThanOrEqual(page.nextSince);
    }
    // The frame shape is the usual one.
    expect(Object.keys(whole.pages[0] as object).sort()).toEqual([
      'changes',
      'hasMore',
      'nextSince',
      'serverRev',
    ]);
  });

  test('only the next page of the same session continues the bound: another session is a normal feed', async () => {
    const first = await sync(tokens.owner, '?since=0&limit=3');
    expect(first.hasMore).toBe(true);
    // Another session at the very cursor of the chain is a returning device, not this chain.
    const other = await walk(tokens.manager, 500, first.nextSince);
    expect(orderIdsOf(other.changes)).toContain(old.closedPaid.id);
    // The chain itself is untouched by that: its next page is still bounded.
    const next = await walk(tokens.owner, 500, first.nextSince);
    expect(orderIdsOf(next.changes)).not.toContain(old.closedPaid.id);
  });

  test('the same session at any other cursor is a normal feed, and leaves the chain alone', async () => {
    const first = await sync(tokens.owner, '?since=0&limit=3');
    expect(first.hasMore).toBe(true);
    const stray = await walk(tokens.owner, 500, first.nextSince - 1);
    expect(orderIdsOf(stray.changes)).toContain(old.closedPaid.id);
    const next = await walk(tokens.owner, 500, first.nextSince);
    expect(orderIdsOf(next.changes)).not.toContain(old.closedPaid.id);
  });

  test('a chain left alone past its time-out falls back to the normal feed: more rows, none missing', async () => {
    const first = await sync(tokens.manager, '?since=0&limit=3');
    expect(first.hasMore).toBe(true);
    h.clock.advanceSeconds(121); // the chain waits two minutes for its next page
    const late = await walk(tokens.manager, 500, first.nextSince);
    expect(orderIdsOf(late.changes)).toContain(old.closedPaid.id);
    // Within the time, the same request was bounded (see the tests above).
  });
});

describe('a device that resumes (since > 0) still gets every later change', () => {
  test('the void of a closed old payment reaches it, with its order', async () => {
    const owners = await signIn();
    const caught = await walk(owners.owner);
    const cursor = caught.pages[caught.pages.length - 1]?.nextSince ?? 0;
    expect(orderIdsOf(caught.changes)).not.toContain(old.closedPaid.id);

    // A manager who has stepped up voids the old order's confirmed cash payment.
    await ok(call('POST', '/v1/auth/step-up', owners.manager, { pin: staff.manager.pin }));
    await ok(
      call('POST', `/v1/payments/${pay.oldPaid.id}/void`, owners.manager, { reason: 'ทดสอบ' }),
    );

    const delta = await sync(owners.owner, `?since=${cursor}&limit=500`);
    const payment = delta.changes.find(
      (c) => c.type === 'payment.upserted' && c.id === pay.oldPaid.id,
    );
    const order = delta.changes.find(
      (c) => c.type === 'order.upserted' && c.id === old.closedPaid.id,
    );
    expect(payment?.type === 'payment.upserted' && payment.data.status).toBe('voided');
    expect(order?.type === 'order.upserted' && order.data.paymentStatus).toBe('unpaid');
    expect(delta.hasMore).toBe(false);

    // A fresh device afterwards still gets the bounded set: the old order is still history.
    const fresh = await walk(owners.owner);
    expect(orderIdsOf(fresh.changes)).not.toContain(old.closedPaid.id);
  });

  test('an old order that changes after the first page is sent is not dropped from the later pages', async () => {
    const owners = await signIn();
    // Page 1 ends right after the old open order, which is delivered as still open...
    const whole = await walk(owners.owner);
    const at = whole.changes.findIndex((c) => c.id === old.openToClose.id);
    expect(at).toBeGreaterThanOrEqual(0);
    const first = await sync(owners.owner, `?since=0&limit=${at + 1}`);
    expect(first.hasMore).toBe(true);
    const seen = first.changes.find((c) => c.id === old.openToClose.id);
    expect(seen?.type === 'order.upserted' && seen.data.status).toBe('preparing');

    // ...then it is finished, so it no longer matches the window by itself.
    await complete(owners.cashier, old.openToClose.id);

    const rest = await walk(owners.owner, 500, first.nextSince);
    const updated = rest.changes.find((c) => c.id === old.openToClose.id);
    expect(updated?.type === 'order.upserted' && updated.data.status).toBe('completed');
  });
});
