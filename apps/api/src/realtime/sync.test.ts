/**
 * `GET /v1/sync` on the real app and an in-memory Postgres (PGlite): who may call it, paging, what
 * each role gets, that it matches what the WebSocket pushed, and that nothing forbidden is in it.
 *
 * Not proven here: real-Postgres commit ordering (the race the client rewind exists for), and
 * volumes beyond a test database.
 */
import { type SyncChange, type SyncResponse, syncResponseSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AppEvent } from '../events.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { frameFromEvent } from './frames.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', { id: string; pin: string }>;
const tokens = {} as Record<'cashier' | 'manager' | 'kitchen' | 'owner', string>;

// Test identifiers only, not real ones.
const PHONE = '0899994321';
const CUSTOMER_PHONE = '0811110002';
const LINE_USER = 'U-SENTINEL-line-user';

const roles = ['kitchen', 'cashier', 'manager', 'owner'] as const;
type Role = (typeof roles)[number];

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

async function sync(role: Role, query = ''): Promise<SyncResponse> {
  const res = await call('GET', `/v1/sync${query}`, tokens[role]);
  expect(res.statusCode, res.body).toBe(200);
  return syncResponseSchema.parse(res.json());
}

/** Every page from `since`, concatenated. */
async function everything(role: Role, limit = 500, since = 0) {
  const changes: SyncChange[] = [];
  const pages: SyncResponse[] = [];
  let cursor = since;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await sync(role, `?since=${cursor}&limit=${limit}`);
    pages.push(page);
    changes.push(...page.changes);
    if (!page.hasMore) break;
    cursor = page.nextSince;
  }
  return { changes, pages };
}

const keyOf = (c: SyncChange) => `${c.type}${'kind' in c ? `:${c.kind}` : ''}:${c.id}`;
const kindsOf = (changes: SyncChange[]) =>
  new Set(changes.map((c) => ('kind' in c ? `${c.type}:${c.kind}` : c.type)));

let order1: { id: string };
let order2: { id: string };
let sentinels: string[] = [];

beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner();
  device = await h.newDevice();
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }
  h.clock.set('2028-04-01T03:00:00.000Z');
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    tokens[role] = await h.pinSession(device.token, staff[role].id, staff[role].pin);
  }
  tokens.owner = await h.ownerSession(owner);

  // --- settings (owner, stepped up) ---
  h.clock.advanceSeconds(90);
  const stepped = await h.steppedUpOwner(owner);
  await ok(
    call('PATCH', '/v1/settings/promptpay', stepped, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    }),
  );
  await ok(
    call('PATCH', '/v1/settings/shop', tokens.manager, { expectedVersion: 0, nameTh: 'ร้านทดสอบ' }),
  );
  await ok(
    call('PATCH', '/v1/settings/payments', tokens.manager, { expectedVersion: 0, other: true }),
  );
  await ok(
    call('PUT', '/v1/settings/delivery', tokens.manager, {
      expectedVersion: 0,
      buildings: ['A1', 'B1'],
    }),
  );
  await h.client.query(
    `insert into gov_copay_schemes (code, name_th, gov_share_bp, gov_daily_cap_satang, active_from,
       active_to, active_from_minute, active_to_minute, channels, enabled)
     values ('test', 'ไทยช่วยไทย', 6000, 20000, '2026-10-01', '2030-12-31', 360, 1380, '{storefront}', true)`,
  );

  // --- menu through the real routes, so each write publishes ---
  const category = await ok(
    call('POST', '/v1/menu/categories', tokens.manager, { nameTh: 'หมวดเส้น' }),
    201,
  );
  const group = await ok(
    call('POST', '/v1/menu/modifier-groups', tokens.manager, {
      nameTh: 'เส้น',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { nameTh: 'เล็ก', costDeltaSatang: 7_777_703 },
        { nameTh: 'ใหญ่', priceDeltaSatang: 500, costDeltaSatang: 7_777_703 },
      ],
    }),
    201,
  );
  const item = await ok(
    call('POST', '/v1/menu/items', tokens.manager, {
      categoryId: category.id,
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      priceSatang: 5000,
      estCostSatang: 7_777_702,
      channels: ['storefront', 'line', 'grab'],
      channelPrices: { grab: 6500 },
      modifierGroupIds: [group.id],
    }),
    201,
  );
  await ok(
    call('PATCH', `/v1/menu/items/${item.id}/availability`, tokens.kitchen, { isAvailable: false }),
  );
  await ok(
    call('PATCH', `/v1/menu/items/${item.id}/availability`, tokens.kitchen, { isAvailable: true }),
  );
  const options = (group.options as { id: string }[]).map((o) => o.id);

  // --- orders and payments ---
  const place = async (extra: Record<string, unknown> = {}) =>
    (await ok(
      call('POST', '/v1/orders', tokens.cashier, {
        clientRequestId: crypto.randomUUID(),
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Test Recipient',
        items: [{ menuItemId: item.id, qty: 2, modifierOptionIds: [options[1]] }],
        ...extra,
      }),
      201,
    )) as { id: string };
  order1 = await place();
  order2 = await place({ note: 'ไม่ใส่ผัก' });
  await ok(
    call('POST', `/v1/orders/${order1.id}/payments`, tokens.cashier, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 20000,
    }),
    201,
  );
  await ok(
    call('POST', `/v1/orders/${order2.id}/payments`, tokens.cashier, {
      clientRequestId: crypto.randomUUID(),
      method: 'promptpay',
    }),
    201,
  );
  await ok(call('POST', `/v1/orders/${order1.id}/transition`, tokens.kitchen, { to: 'ready' }));

  // --- a customer with personal data, and failed PINs (they bump staff.version) ---
  await h.client.query(
    `insert into customers (line_user_id, display_name, nickname, phone, room_no, picture_url, note, order_count, total_spent_satang)
     values ($1, 'คุณสมชาย', 'ชาย', $2, '1204', 'https://img.example.test/p.jpg', 'NOTE-SENTINEL', 3, 15000)`,
    [LINE_USER, CUSTOMER_PHONE],
  );
  for (let i = 0; i < 2; i += 1) {
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      headers: { 'x-device-token': device.token },
      payload: { staffId: staff.cashier.id, pin: '0000' },
      remoteAddress: h.nextIp(),
    });
  }

  const staffRows = await h.client.query<{ pin_hash: string }>('select pin_hash from staff');
  const deviceRows = await h.client.query<{ token_hash: string }>('select token_hash from devices');
  const requestHashes = await h.client.query<{ h: string }>(
    'select request_hash as h from orders union select request_hash from payments',
  );
  sentinels = [
    PHONE,
    CUSTOMER_PHONE,
    LINE_USER,
    'NOTE-SENTINEL',
    'https://img.example.test/p.jpg',
    device.token,
    ...Object.values(tokens),
    ...staffRows.rows.map((r) => r.pin_hash).filter(Boolean),
    ...deviceRows.rows.map((r) => r.token_hash),
    ...requestHashes.rows.map((r) => r.h).filter(Boolean),
  ];
}, 120_000);
afterAll(async () => {
  await h.close();
});

// ---------- Access and validation ----------

describe('GET /v1/sync: who and how', () => {
  test('needs a session; every role may call it', async () => {
    expect((await call('GET', '/v1/sync', undefined)).statusCode).toBe(401);
    expect((await call('GET', '/v1/sync', 'x'.repeat(30))).statusCode).toBe(401);
    for (const role of roles) {
      const page = await sync(role);
      expect(page.serverRev, role).toBeGreaterThan(0);
    }
  });

  test('a PIN session still needs its device token, like every other route', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/sync',
      headers: { authorization: `Bearer ${tokens.cashier}`, 'x-test-no-device-autofill': '1' },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'DEVICE_MISMATCH' });
  });

  test.each([
    ['a negative since', '?since=-1'],
    ['a fractional since', '?since=1.5'],
    ['a non-number since', '?since=abc'],
    ['a zero limit', '?limit=0'],
    ['a limit above the cap', '?limit=501'],
    ['a repeated parameter', '?since=1&since=2'],
    ['an unknown parameter', '?role=owner'],
  ])('%s is a 400 with the standard error shape', async (_name, query) => {
    const res = await call('GET', `/v1/sync${query}`, tokens.owner);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.any(Object) });
  });

  test('is rate limited per address (120 a minute), with the standard error shape', async () => {
    const ip = '10.99.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < 125; i += 1) {
      const res = await h.app.inject({
        method: 'GET',
        url: '/v1/sync?limit=1',
        headers: { authorization: `Bearer ${tokens.kitchen}` },
        remoteAddress: ip,
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.json()).toMatchObject({ code: 'RATE_LIMITED' });
        break;
      }
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(120);
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  test('answers are never cached', async () => {
    const res = await call('GET', '/v1/sync', tokens.owner);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the response is {changes, nextSince, hasMore, serverRev}, in rev order', async () => {
    const page = await sync('owner');
    expect(Object.keys(page).sort()).toEqual(['changes', 'hasMore', 'nextSince', 'serverRev']);
    const revs = page.changes.map((c) => c.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(page.nextSince).toBe(revs[revs.length - 1]);
    expect(page.serverRev).toBeGreaterThanOrEqual(page.nextSince);
  });
});

// ---------- What each role gets ----------

describe('what each role is sent', () => {
  test('the kitchen: orders and the menu, nothing else', async () => {
    const { changes } = await everything('kitchen');
    expect(kindsOf(changes)).toEqual(
      new Set([
        'order.upserted',
        'menu.upserted:category',
        'menu.upserted:item',
        'menu.upserted:group',
        'menu.upserted:option',
      ]),
    );
  });

  test.each(['cashier', 'manager', 'owner'] as const)(
    '%s: orders, payments, the menu, settings (masked PromptPay, the co-pay scheme) and customers',
    async (role) => {
      const { changes } = await everything(role);
      expect(kindsOf(changes)).toEqual(
        new Set([
          'order.upserted',
          'payment.upserted',
          'menu.upserted:category',
          'menu.upserted:item',
          'menu.upserted:group',
          'menu.upserted:option',
          'settings.updated',
          'customer.upserted',
        ]),
      );
      const settings = changes.filter((c) => c.type === 'settings.updated');
      expect(settings.map((c) => c.id).sort()).toEqual([
        'delivery',
        'gov_copay',
        'payment_methods',
        'promptpay',
        'shop',
      ]);
      expect(settings.find((c) => c.id === 'delivery')?.data).toEqual({
        buildings: ['A1', 'B1'],
      });
      const promptpay = settings.find((c) => c.id === 'promptpay');
      expect(promptpay?.data).toEqual({ idType: 'phone', idMasked: '******4321' });
    },
  );

  test('the same entity has the same frame for every role that may see it', async () => {
    const byRole = await Promise.all(roles.map(async (r) => [r, await everything(r)] as const));
    const owners = new Map(
      byRole.find(([r]) => r === 'owner')?.[1].changes.map((c) => [keyOf(c), c]),
    );
    for (const [role, { changes }] of byRole) {
      for (const c of changes) expect(c, `${role} ${keyOf(c)}`).toEqual(owners.get(keyOf(c)));
    }
  });

  test('customers are cut down: no LINE id, phone, picture or note, and the id is the row id', async () => {
    const { changes } = await everything('cashier');
    // (The orders in this fixture also remembered their recipients as nameless counter customers.)
    const c = changes.find(
      (x) =>
        x.type === 'customer.upserted' &&
        (x.data as { displayName: string | null }).displayName === 'คุณสมชาย',
    );
    expect(c?.data).toMatchObject({
      displayName: 'คุณสมชาย',
      nickname: 'ชาย',
      roomNo: '1204',
      orderCount: 3,
      totalSpentSatang: 15000,
      anonymized: false,
    });
    expect(Object.keys(c?.data as object).sort()).toEqual(
      [
        'anonymized',
        'displayName',
        'firstSeenAt',
        'id',
        'lastOrderAt',
        'nickname',
        'orderCount',
        'rev',
        'roomNo',
        'totalSpentSatang',
        'version',
      ].sort(),
    );
  });
});

// ---------- Paging ----------

describe('paging', () => {
  test('pages of 3 add up to exactly the unpaged result, with exact hasMore and a moving cursor', async () => {
    const whole = await everything('owner', 500);
    expect(whole.pages).toHaveLength(1);
    const paged = await everything('owner', 3);
    expect(paged.changes.map(keyOf)).toEqual(whole.changes.map(keyOf));
    expect(paged.pages.length).toBeGreaterThan(3);
    let last = 0;
    for (const [i, page] of paged.pages.entries()) {
      expect(page.changes.length).toBeLessThanOrEqual(3);
      expect(page.nextSince).toBeGreaterThan(last);
      last = page.nextSince;
      expect(page.hasMore).toBe(i < paged.pages.length - 1);
    }
  });

  test('since is exclusive, and the end of the feed answers empty with the cursor where it was', async () => {
    const whole = await everything('owner', 500);
    const end = whole.pages[0]?.nextSince ?? 0;
    const after = await sync('owner', `?since=${end}`);
    expect(after.changes).toEqual([]);
    expect(after.hasMore).toBe(false);
    expect(after.nextSince).toBe(end);
    const before = await sync('owner', `?since=${end - 1}&limit=500`);
    expect(before.changes).toHaveLength(1);
  });

  test('a later write shows up on the next catch-up, once, and nothing else does', async () => {
    const { pages } = await everything('kitchen', 500);
    const cursor = pages[pages.length - 1]?.nextSince ?? 0;
    // Deactivating a category is a menu write the kitchen may see.
    const categories = (await everything('owner')).changes.filter(
      (c) => c.type === 'menu.upserted' && c.kind === 'category',
    );
    const target = categories[0] as Extract<SyncChange, { kind: 'category' }>;
    await ok(
      call('PATCH', `/v1/menu/categories/${target.id}`, tokens.manager, {
        expectedVersion: target.data.version,
        nameTh: 'หมวดเปลี่ยนชื่อ',
      }),
    );
    const delta = await sync('kitchen', `?since=${cursor}`);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({
      type: 'menu.upserted',
      kind: 'category',
      id: target.id,
      data: { nameTh: 'หมวดเปลี่ยนชื่อ', version: target.data.version + 1 },
    });
    // The same entity again at a newer rev replaces, never duplicates: one frame per entity here.
    const all = await everything('kitchen');
    expect(all.changes.filter((c) => keyOf(c) === keyOf(target))).toHaveLength(1);
  });

  test('a rewind (the client safety margin) only replays frames, each at its own rev', async () => {
    const whole = await everything('owner');
    const head = whole.pages[0]?.nextSince ?? 0;
    const replay = await sync('owner', `?since=${Math.max(0, head - 5)}&limit=500`);
    const known = new Map(whole.changes.map((c) => [keyOf(c), c]));
    expect(replay.changes.length).toBeGreaterThan(0);
    for (const c of replay.changes) expect(c).toEqual(known.get(keyOf(c)));
  });
});

// ---------- It matches what the WebSocket pushed ----------

describe('catch-up and live frames agree', () => {
  test('for every entity that has both, the newest live frame equals the sync frame at that rev', async () => {
    const live = new Map<string, Record<string, unknown>>();
    for (const built of h.events.map((e: AppEvent) => frameFromEvent(e))) {
      if (built.kind !== 'frame' || built.frame.type === 'alert.new_order') continue;
      const key = keyOf(built.frame as SyncChange);
      const previous = live.get(key);
      if (!previous || (built.frame.rev as number) >= (previous.rev as number)) {
        live.set(key, built.frame as unknown as Record<string, unknown>);
      }
    }
    const { changes } = await everything('owner');
    const compared = new Set<string>();
    for (const c of changes) {
      const frame = live.get(keyOf(c));
      if (!frame || frame.rev !== c.rev) continue; // changed again after the scenario's snapshot
      expect(c, keyOf(c)).toEqual(frame);
      compared.add(c.type === 'menu.upserted' ? `menu:${c.kind}` : c.type);
    }
    for (const needed of [
      'order.upserted',
      'payment.upserted',
      'menu:category',
      'menu:item',
      'menu:group',
      'menu:option',
      'settings.updated',
    ]) {
      expect(compared.has(needed), `no ${needed} was comparable`).toBe(true);
    }
  });
});

// ---------- What must never be in it ----------

describe('nothing forbidden, for any role', () => {
  test.each(roles)(
    '%s: no secret value, no cost, no hash, no token, no QR payload',
    async (role) => {
      const { changes, pages } = await everything(role);
      const text = JSON.stringify({ changes, pages });
      for (const secret of sentinels)
        expect(text, `${role} must not see ${secret.slice(0, 12)}`).not.toContain(secret);
      expect(text, role).not.toMatch(
        /cost|pinHash|pin_hash|tokenHash|token_hash|requestHash|request_hash|qrPayload|qr_payload|idValue|lineUserId|line_user_id|failedPin|lockedUntil|stepUp|slip|clientRequestId|updatedBy|commission/i,
      );
      // The test numbers used for costs.
      expect(text).not.toMatch(/7777702|7777703/);
    },
  );

  test('order lines carry their modifiers without the cost snapshot', async () => {
    const { changes } = await everything('cashier');
    const order = changes.find((c) => c.type === 'order.upserted' && c.id === order1.id);
    if (order?.type !== 'order.upserted') throw new Error('order missing');
    expect(order.data.items[0]?.modifiers[0]).toEqual({
      groupId: expect.any(String),
      optionId: expect.any(String),
      nameTh: 'ใหญ่',
      nameEn: null,
      priceDeltaSatang: 500,
    });
    expect(order.data.totalSatang).toBe(11000);
  });

  test('payments show the masked target and the shares, never a QR payload', async () => {
    const { changes } = await everything('cashier');
    const pp = changes.find((c) => c.type === 'payment.upserted' && c.data.orderId === order2.id);
    if (pp?.type !== 'payment.upserted') throw new Error('payment missing');
    expect(pp.data).toMatchObject({
      method: 'promptpay',
      status: 'pending',
      promptpayTargetMasked: '******4321',
    });
  });

  test('failed PIN attempts bump staff rows but nothing about staff reaches any feed', async () => {
    const before = await sync('owner');
    const bumped = await h.client.query<{ n: string }>(
      'select count(*)::text as n from staff where failed_pin_count > 0',
    );
    expect(Number(bumped.rows[0]?.n)).toBeGreaterThan(0);
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/v1/auth/pin',
        headers: { 'x-device-token': device.token },
        payload: { staffId: staff.manager.id, pin: '1111' },
        remoteAddress: h.nextIp(),
      });
    }
    const after = await sync('owner', `?since=${before.nextSince}`);
    expect(after.changes).toEqual([]);
    expect(after.nextSince).toBe(before.nextSince);
    // ...though the revs were used: the server's counter moved.
    expect(after.serverRev).toBeGreaterThan(before.serverRev);
  });
});

// ---------- Rows that are gone, and rows that are wrong ----------

describe('removed and malformed rows', () => {
  test('a deactivated category and an archived item travel flagged, so devices can drop them', async () => {
    const owners = (await everything('owner')).changes;
    const category = owners.find(
      (c) => c.type === 'menu.upserted' && c.kind === 'category',
    ) as Extract<SyncChange, { kind: 'category' }>;
    const item = owners.find((c) => c.type === 'menu.upserted' && c.kind === 'item') as Extract<
      SyncChange,
      { kind: 'item' }
    >;
    const cursor = (await sync('owner')).nextSince;
    await ok(call('DELETE', `/v1/menu/categories/${category.id}`, tokens.manager));
    await ok(call('DELETE', `/v1/menu/items/${item.id}`, tokens.manager));
    const delta = (await everything('kitchen', 500, cursor)).changes;
    expect(delta.find((c) => c.id === category.id)).toMatchObject({ data: { active: false } });
    expect(delta.find((c) => c.id === item.id)).toMatchObject({ data: { archived: true } });
  });

  test('a row that does not fit its frame is skipped, the page goes on, and the log names no content', async () => {
    const cursor = (await sync('owner')).nextSince;
    await h.client.query(
      `insert into settings (key, value) values ('opening_hours', '{"bogus":"BOGUS-SENTINEL"}')
       on conflict (key) do update set value = excluded.value`,
    );
    await h.client.query("update settings set value = value where key = 'shop'"); // a good row after it
    const page = await sync('owner', `?since=${cursor}`);
    expect(page.changes.map((c) => c.id)).toEqual(['shop']);
    expect(page.nextSince).toBeGreaterThan(cursor + 1); // moved past the bad row too
    expect(h.logs()).toContain('sync row dropped');
    expect(h.logs()).not.toContain('BOGUS-SENTINEL');
    await h.client.query("delete from settings where key = 'opening_hours'");
  });

  test('a setting nobody listed never travels, whatever it holds', async () => {
    await h.client.query(
      `insert into settings (key, value) values ('line_channel_secret', '{"secret":"LINE-SECRET-SENTINEL"}')`,
    );
    for (const role of roles) {
      const text = JSON.stringify((await everything(role)).changes);
      expect(text).not.toContain('LINE-SECRET-SENTINEL');
      expect(text).not.toContain('line_channel_secret');
    }
  });
});
