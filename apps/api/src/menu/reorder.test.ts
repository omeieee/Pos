/**
 * POST /v1/menu/reorder: one transaction sets `sort` 0..n-1 for exactly one sibling set, with a
 * version check on every row, one audit row and events after commit, and writes nothing when the
 * order is already right.
 */
import type { CategoryDto, GroupDto, ItemDto } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function as(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
const uid = () => crypto.randomUUID().slice(0, 8);

interface Ref {
  id: string;
  version: number;
}
const ref = (r: Ref) => ({ id: r.id, expectedVersion: r.version });

async function newCategory(token: string, sort = 0) {
  return (
    await call('POST', '/v1/menu/categories', token, { nameTh: `c ${uid()}`, sort })
  ).json() as CategoryDto;
}
async function newItem(token: string, categoryId: string, sort: number) {
  return (
    await call('POST', '/v1/menu/items', token, {
      categoryId,
      nameTh: `i ${uid()}`,
      priceSatang: 100,
      channels: ['storefront'],
      sort,
    })
  ).json() as ItemDto;
}
async function newGroup(token: string, sort = 0) {
  return (
    await call('POST', '/v1/menu/modifier-groups', token, {
      nameTh: `g ${uid()}`,
      minSelect: 0,
      maxSelect: 3,
      sort,
      options: [
        { nameTh: 'a', sort: 1 },
        { nameTh: 'b', sort: 2 },
        { nameTh: 'c', sort: 3 },
      ],
    })
  ).json() as GroupDto;
}

interface ReorderResult {
  kind: string;
  parentId: string | null;
  changed: number;
  rows: { id: string; sort: number; version: number; rev: number }[];
}
const reorder = (token: string | undefined, body: unknown) =>
  call('POST', '/v1/menu/reorder', token, body);

const auditCount = async () =>
  Number(
    (
      (await h.client.query<{ n: number }>(
        `select count(*)::int as n from audit_log where action = 'menu.reorder'`,
      )) as { rows: { n: number }[] }
    ).rows[0]?.n,
  );

/** Three items in a category, sorted a, b, c (sort 0, 1, 2). */
async function three(token: string) {
  const cat = await newCategory(token);
  const a = await newItem(token, cat.id, 0);
  const b = await newItem(token, cat.id, 1);
  const c = await newItem(token, cat.id, 2);
  return { cat, a, b, c };
}
const listed = async (token: string, categoryId: string) =>
  (
    ((await call('GET', '/v1/menu/items', token)).json() as { items: ItemDto[] }).items as ItemDto[]
  ).filter((i) => i.categoryId === categoryId);

describe('reordering items', () => {
  test('sets sort 0..n-1, bumps only the rows that moved, one audit row, events after commit', async () => {
    const token = await as('manager');
    const { cat, a, b, c } = await three(token);
    const auditBefore = await auditCount();
    const eventsBefore = h.events.length;

    // a stays first; b and c swap.
    const res = await reorder(token, {
      kind: 'items',
      parentId: cat.id,
      order: [ref(a), ref(c), ref(b)],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReorderResult;
    expect(body).toMatchObject({ kind: 'items', parentId: cat.id, changed: 2 });
    expect(body.rows.map((r) => [r.id, r.sort])).toEqual([
      [a.id, 0],
      [c.id, 1],
      [b.id, 2],
    ]);
    const by = new Map(body.rows.map((r) => [r.id, r]));
    expect(by.get(a.id)).toMatchObject({ version: a.version, rev: a.rev }); // untouched
    expect(by.get(b.id)?.version).toBe(b.version + 1);
    expect(by.get(c.id)?.version).toBe(c.version + 1);
    expect(by.get(b.id)?.rev).toBeGreaterThan(b.rev);

    const now = await listed(token, cat.id);
    expect(now.map((i) => [i.id, i.sort])).toEqual([
      [a.id, 0],
      [c.id, 1],
      [b.id, 2],
    ]);

    expect((await auditCount()) - auditBefore).toBe(1);
    const published = h.events
      .slice(eventsBefore)
      .filter((e) => e.type === 'menu.upserted') as unknown as { kind: string; id: string }[];
    expect(published.map((e) => `${e.kind}:${e.id}`).sort()).toEqual(
      [`item:${b.id}`, `item:${c.id}`].sort(),
    );
    expect(JSON.stringify(published)).not.toMatch(/estCost|costDelta/);
  });

  test('normalises gaps and duplicates to 0..n-1', async () => {
    const token = await as('manager');
    const cat = await newCategory(token);
    const a = await newItem(token, cat.id, 50);
    const b = await newItem(token, cat.id, 50);
    const body = (
      await reorder(token, { kind: 'items', parentId: cat.id, order: [ref(b), ref(a)] })
    ).json() as ReorderResult;
    expect(body.rows.map((r) => r.sort)).toEqual([0, 1]);
    expect(body.rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test('the same order again writes, audits and publishes nothing, even with old versions', async () => {
    const token = await as('manager');
    const { cat, a, b, c } = await three(token);
    const request = { kind: 'items', parentId: cat.id, order: [ref(c), ref(b), ref(a)] };
    const first = (await reorder(token, request)).json() as ReorderResult;
    expect(first.changed).toBe(2);

    const auditBefore = await auditCount();
    const eventsBefore = h.events.length;
    const again = await reorder(token, request); // a retry: the versions in it are now stale
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ changed: 0, rows: first.rows });
    expect(await auditCount()).toBe(auditBefore);
    expect(h.events.length).toBe(eventsBefore);
  });

  test('a stale version anywhere is a 409 and nothing at all is written', async () => {
    const token = await as('manager');
    const { cat, a, b, c } = await three(token);
    // Someone edits c after the editor loaded it.
    await call('PATCH', `/v1/menu/items/${c.id}`, token, {
      expectedVersion: c.version,
      nameTh: `renamed ${uid()}`,
    });
    const auditBefore = await auditCount();
    const eventsBefore = h.events.length;
    const res = await reorder(token, {
      kind: 'items',
      parentId: cat.id,
      order: [ref(c), ref(b), ref(a)],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await listed(token, cat.id)).map((i) => [i.id, i.sort])).toEqual([
      [a.id, 0],
      [b.id, 1],
      [c.id, 2],
    ]);
    expect(await auditCount()).toBe(auditBefore);
    expect(h.events.length).toBe(eventsBefore);
  });

  test('ids outside the sibling set, missing ones and archived ones are a 409', async () => {
    const token = await as('manager');
    const { cat, a, b, c } = await three(token);
    const other = await newItem(token, (await newCategory(token)).id, 0);
    const base = { kind: 'items', parentId: cat.id };

    for (const order of [
      [ref(a), ref(b), ref(other)], // a stranger in place of c
      [ref(a), ref(b)], // c is missing
      [ref(a), ref(b), ref(c), ref(other)], // one too many
    ]) {
      const res = await reorder(token, { ...base, order });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REORDER_SET_MISMATCH' });
    }

    // An archived item is not a sibling: it must not be sent, and the live ones are the set.
    const archived = (await call('DELETE', `/v1/menu/items/${c.id}`, token)).json() as ItemDto;
    expect(
      (await reorder(token, { ...base, order: [ref(a), ref(b), ref(archived)] })).statusCode,
    ).toBe(409);
    expect((await reorder(token, { ...base, order: [ref(b), ref(a)] })).statusCode).toBe(200);
  });

  test('the same id twice, an empty order and a missing parent are a 400; an unknown parent is a 404', async () => {
    const token = await as('manager');
    const { cat, a } = await three(token);
    expect(
      (await reorder(token, { kind: 'items', parentId: cat.id, order: [ref(a), ref(a)] }))
        .statusCode,
    ).toBe(400);
    expect((await reorder(token, { kind: 'items', parentId: cat.id, order: [] })).statusCode).toBe(
      400,
    );
    expect((await reorder(token, { kind: 'items', order: [ref(a)] })).statusCode).toBe(400);
    expect(
      (await reorder(token, { kind: 'categories', parentId: cat.id, order: [ref(cat)] }))
        .statusCode,
    ).toBe(400);
    expect((await reorder(token, { kind: 'shelves', order: [ref(a)] })).statusCode).toBe(400);
    expect(
      (
        await reorder(token, {
          kind: 'items',
          parentId: crypto.randomUUID(),
          order: [ref(a)],
        })
      ).statusCode,
    ).toBe(404);
  });

  test('two reorders racing on the same versions: one wins, the other is a 409', async () => {
    const token = await as('manager');
    const { cat, a, b, c } = await three(token);
    const [x, y] = await Promise.all([
      reorder(token, { kind: 'items', parentId: cat.id, order: [ref(c), ref(a), ref(b)] }),
      reorder(token, { kind: 'items', parentId: cat.id, order: [ref(b), ref(c), ref(a)] }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const sorts = (await listed(token, cat.id)).map((i) => i.sort);
    expect(sorts).toEqual([0, 1, 2]);
  });
});

describe('reordering the other kinds', () => {
  test('categories: every category is a sibling, inactive ones included', async () => {
    const token = await as('manager');
    const rows = (
      (await call('GET', '/v1/menu/categories', token)).json() as { categories: CategoryDto[] }
    ).categories;
    const off = await newCategory(token, 900);
    const gone = (await call('DELETE', `/v1/menu/categories/${off.id}`, token)).json() as Ref;
    const all = [...rows.filter((r) => r.id !== off.id), { ...off, ...gone }].reverse();
    const res = await reorder(token, { kind: 'categories', order: all.map(ref) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReorderResult;
    expect(body).toMatchObject({ kind: 'categories', parentId: null });
    expect(body.rows.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(body.rows.map((r) => r.sort)).toEqual(all.map((_, i) => i));
    const after = (
      (await call('GET', '/v1/menu/categories', token)).json() as { categories: CategoryDto[] }
    ).categories;
    expect(after.map((c) => c.id)).toEqual(all.map((r) => r.id));
  });

  test('groups: the live groups are the set, and the event carries the group with its options', async () => {
    const token = await as('manager');
    const live = (
      (await call('GET', '/v1/menu/modifier-groups', token)).json() as { groups: GroupDto[] }
    ).groups;
    const g1 = await newGroup(token, 5);
    const g2 = await newGroup(token, 6);
    const order = [g2, g1, ...live];
    const eventsBefore = h.events.length;
    const res = await reorder(token, { kind: 'groups', order: order.map(ref) });
    expect(res.statusCode).toBe(200);
    const events = h.events.slice(eventsBefore) as unknown as {
      type: string;
      kind: string;
      id: string;
      data: GroupDto;
    }[];
    const e = events.find((x) => x.type === 'menu.upserted' && x.id === g2.id);
    expect(e).toMatchObject({ kind: 'group' });
    expect(e?.data.options.length).toBe(3);
    const after = (
      (await call('GET', '/v1/menu/modifier-groups', token)).json() as { groups: GroupDto[] }
    ).groups;
    expect(after.slice(0, 2).map((g) => g.id)).toEqual([g2.id, g1.id]);
  });

  test('options: parentId is the group, and archived options are not siblings', async () => {
    const token = await as('manager');
    const group = await newGroup(token);
    const [a, b, c] = group.options as [
      GroupDto['options'][0],
      GroupDto['options'][0],
      GroupDto['options'][0],
    ];
    const res = await reorder(token, {
      kind: 'options',
      parentId: group.id,
      order: [ref(c), ref(b), ref(a)],
    });
    expect(res.statusCode).toBe(200);
    const after = (
      (await call('GET', '/v1/menu/modifier-groups', token)).json() as { groups: GroupDto[] }
    ).groups.find((g) => g.id === group.id);
    expect(after?.options.map((o) => o.id)).toEqual([c.id, b.id, a.id]);
    expect(after?.options.map((o) => o.sort)).toEqual([0, 1, 2]);

    const removed = (
      await call('DELETE', `/v1/menu/modifier-options/${b.id}`, token)
    ).json() as Ref;
    const body = (
      await reorder(token, {
        kind: 'options',
        parentId: group.id,
        order: [ref({ ...a, version: a.version + 1 }), ref({ ...c, version: c.version + 1 })],
      })
    ).json() as ReorderResult;
    expect(body.rows.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(removed.version).toBeGreaterThan(b.version);
  });
});

describe('who may reorder', () => {
  test('cashier and kitchen get 403, an unsigned caller 401, and nothing changes', async () => {
    const manager = await as('manager');
    const { cat, a, b, c } = await three(manager);
    const body = { kind: 'items', parentId: cat.id, order: [ref(c), ref(b), ref(a)] };
    for (const role of ['cashier', 'kitchen'] as const) {
      expect((await reorder(await as(role), body)).statusCode).toBe(403);
    }
    expect((await reorder(undefined, body)).statusCode).toBe(401);
    expect((await listed(manager, cat.id)).map((i) => i.id)).toEqual([a.id, b.id, c.id]);
  });
});
