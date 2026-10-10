import type { PGlite } from '@electric-sql/pglite';
import { FULFILLMENTS } from '@sds/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import { SYNCED_TABLES } from './schema.ts';
import { seed } from './seed.ts';

let db: PgliteDb;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);

afterAll(async () => {
  await client.close();
});

/** Drizzle wraps driver errors; the Postgres message and constraint name are on `cause`. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'expected the query to fail').toBeInstanceOf(Error);
  const cause = (error as Error).cause as { message?: string; constraint?: string } | undefined;
  expect(`${cause?.message ?? ''} ${cause?.constraint ?? ''}`).toMatch(pattern);
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

describe('migrations on an empty Postgres', () => {
  test('run on PostgreSQL 17 (same major as Supabase)', async () => {
    const [v] = await rows<{ server_version: string }>(sql`show server_version`);
    expect(v?.server_version).toMatch(/^17\./);
  });

  test('our functions pin search_path (Supabase lint 0011)', async () => {
    const fns = await rows<{ proname: string; proconfig: string[] | null }>(
      sql`select proname, proconfig from pg_proc
          where pronamespace = 'public'::regnamespace
            and proname in ('uuid_generate_v7', 'set_sync_columns', 'forbid_change')
          order by proname`,
    );
    expect(fns.map((f) => f.proname)).toEqual([
      'forbid_change',
      'set_sync_columns',
      'uuid_generate_v7',
    ]);
    for (const f of fns) {
      expect(f.proconfig ?? []).toContainEqual(
        expect.stringMatching(/^search_path=public,\s*pg_temp$/),
      );
    }
  });

  test('create every table in schema v1', async () => {
    const tables = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      [
        'audit_log',
        'customers',
        'daily_counters',
        'devices',
        'expenses',
        'gov_copay_schemes',
        'line_button_replies',
        'line_events',
        'line_message_log',
        'line_quota_months',
        'menu_categories',
        'menu_item_channel_prices',
        'menu_item_modifier_groups',
        'menu_item_photos',
        'menu_items',
        'modifier_groups',
        'modifier_options',
        'order_items',
        'orders',
        'owner_credentials',
        'payments',
        'sessions',
        'settings',
        'staff',
        'staff_invites',
        'tax_profiles',
      ].sort(),
    );
  });

  test('every synced table has the sync trigger', async () => {
    const triggers = await rows<{ event_object_table: string }>(
      sql`select distinct event_object_table from information_schema.triggers where trigger_name like '%\_sync'`,
    );
    expect(triggers.map((t) => t.event_object_table).sort()).toEqual([...SYNCED_TABLES].sort());
  });

  test('uuid_generate_v7 makes version-7, RFC variant, time-ordered UUIDs', async () => {
    const ids = await rows<{ id: string }>(
      sql`select uuid_generate_v7()::text as id from generate_series(1, 50)`,
    );
    for (const { id } of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const prefix = (s: string) => s.replaceAll('-', '').slice(0, 12);
    const first = ids[0]?.id ?? '';
    const last = ids.at(-1)?.id ?? '';
    expect(prefix(first) <= prefix(last)).toBe(true);
    expect(Math.abs(Number.parseInt(prefix(first), 16) - Date.now())).toBeLessThan(60_000);
  });
});

describe('seed', () => {
  test('loads the placeholder menu and settings, and is idempotent', async () => {
    expect(await seed(db)).toEqual({ seeded: true });
    expect(await seed(db)).toEqual({ seeded: false });

    const [counts] = await rows<Record<string, number>>(sql`select
      (select count(*)::int from menu_categories) as categories,
      (select count(*)::int from menu_items) as items,
      (select count(*)::int from modifier_groups) as groups,
      (select count(*)::int from modifier_options) as options,
      (select count(*)::int from menu_item_modifier_groups) as links,
      (select count(*)::int from settings) as settings,
      (select count(*)::int from gov_copay_schemes where enabled) as enabled_schemes`);
    expect(counts).toEqual({
      categories: 2,
      items: 6,
      groups: 3,
      options: 12,
      links: 12,
      settings: 6,
      enabled_schemes: 1,
    });

    const [delivery] = await rows<{ value: unknown }>(
      sql`select value from settings where key = 'delivery'`,
    );
    expect(delivery?.value).toEqual({
      buildings: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'],
    });

    const [pp] = await rows<{ value: unknown }>(
      sql`select value from settings where key = 'promptpay'`,
    );
    expect(pp?.value).toEqual({ idType: 'phone', idValue: '0642230924' });

    const [price] = await rows<{ price_satang: string | number }>(
      sql`select price_satang from menu_items where name_th = 'ก๋วยเตี๋ยวต้มยำ (ตัวอย่าง)'`,
    );
    expect(Number(price?.price_satang)).toBe(5000);
  });
});

describe('seed: the menu is an obvious placeholder', () => {
  test('every seeded item and category says it is a sample the owner will replace', async () => {
    const items = await rows<{ name_th: string; name_en: string; description_th: string }>(
      sql`select name_th, name_en, description_th from menu_items`,
    );
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.name_th, i.name_th).toContain('(ตัวอย่าง)');
      expect(i.name_en, i.name_en).toContain('(sample)');
      expect(i.description_th).toMatch(/เมนูตัวอย่าง/);
    }
    const categories = await rows<{ name_th: string }>(sql`select name_th from menu_categories`);
    for (const c of categories) expect(c.name_th).toContain('(ตัวอย่าง)');
  });

  test('the noodles are also offered on the delivery channels, with a Grab price', async () => {
    const noodles = await rows<{ channels: string[]; grab: number | null }>(
      sql`select i.channels, (select price_satang from menu_item_channel_prices p where p.item_id = i.id and p.channel = 'grab') as grab
          from menu_items i where i.name_th like 'ก๋วยเตี๋ยวต้มยำ%'`,
    );
    expect(noodles[0]?.channels).toEqual(['storefront', 'line', 'grab', 'lineman']);
    expect(Number(noodles[0]?.grab)).toBe(6500);
  });
});

describe('sync trigger', () => {
  test('insert sets version 1 and a rev; update bumps version and takes a newer rev', async () => {
    const [created] = await rows<{ id: string; version: number; rev: string }>(
      sql`insert into menu_categories (name_th, version, rev) values ('ทดสอบ', 99, 0) returning id, version, rev`,
    );
    expect(created?.version).toBe(1);
    expect(Number(created?.rev)).toBeGreaterThan(0);

    const [updated] = await rows<{ version: number; rev: string }>(
      sql`update menu_categories set sort = 5 where id = ${created?.id} returning version, rev`,
    );
    expect(updated?.version).toBe(2);
    expect(Number(updated?.rev)).toBeGreaterThan(Number(created?.rev));
  });

  test('optimistic locking: an update with a stale version matches no row', async () => {
    const [c] = await rows<{ id: string }>(
      sql`insert into menu_categories (name_th) values ('ล็อก') returning id`,
    );
    await db.execute(sql`update menu_categories set sort = 1 where id = ${c?.id} and version = 1`);
    const stale = await db.execute(
      sql`update menu_categories set sort = 2 where id = ${c?.id} and version = 1`,
    );
    expect(stale.affectedRows).toBe(0);
  });
});

describe('integrity rules', () => {
  async function newOrder() {
    const [o] = await rows<{ id: string }>(sql`insert into orders
      (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
      values ('T-' || uuid_generate_v7(), '2026-09-29', 'storefront', 'takeaway', 'preparing', 5000, 5000, uuid_generate_v7())
      returning id`);
    return o?.id ?? '';
  }

  test('orders and payments cannot be deleted', async () => {
    const orderId = await newOrder();
    await expectDbError(db.execute(sql`delete from orders where id = ${orderId}`), /not allowed/);
    const [p] = await rows<{ id: string }>(sql`insert into payments
      (order_id, method, amount_satang, client_request_id)
      values (${orderId}, 'cash', 5000, uuid_generate_v7()) returning id`);
    await expectDbError(db.execute(sql`delete from payments where id = ${p?.id}`), /not allowed/);
  });

  test('audit log is append-only', async () => {
    const [a] = await rows<{ id: string }>(sql`insert into audit_log (actor_type, action, entity)
      values ('system', 'test', 'settings') returning id`);
    await expectDbError(
      db.execute(sql`update audit_log set action = 'x' where id = ${a?.id}`),
      /not allowed/,
    );
    await expectDbError(db.execute(sql`delete from audit_log where id = ${a?.id}`), /not allowed/);
  });

  test('a payment cannot be confirmed without the confirming staff member (rule 2)', async () => {
    const orderId = await newOrder();
    await expectDbError(
      db.execute(sql`insert into payments (order_id, method, status, amount_satang, client_request_id)
        values (${orderId}, 'promptpay', 'confirmed', 5000, uuid_generate_v7())`),
      /payments_confirmed_by_staff/,
    );
  });

  test('order totals must add up and discounts cannot exceed the subtotal', async () => {
    await expectDbError(
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, status, subtotal_satang, discount_satang, total_satang, client_request_id)
        values ('S-002', '2026-09-29', 'storefront', 'takeaway', 'preparing', 5000, 0, 4000, uuid_generate_v7())`),
      /orders_totals/,
    );
  });

  test('cash change must equal tendered minus amount', async () => {
    const orderId = await newOrder();
    await expectDbError(
      db.execute(sql`insert into payments (order_id, method, amount_satang, tendered_satang, change_satang, client_request_id)
        values (${orderId}, 'cash', 5000, 10000, 4000, uuid_generate_v7())`),
      /payments_cash_change/,
    );
  });

  test('unknown status values are rejected', async () => {
    await expectDbError(
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
        values ('S-003', '2026-09-29', 'storefront', 'takeaway', 'paid', 0, 0, uuid_generate_v7())`),
      /orders_status/,
    );
  });

  test('the fulfilment check takes the entrance delivery and still takes the legacy values', async () => {
    for (const fulfillment of FULFILLMENTS) {
      await db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, room_no, delivery_building, recipient_name,
         status, subtotal_satang, total_satang, client_request_id)
        values ('F-' || uuid_generate_v7(), '2026-09-29', 'storefront', ${fulfillment}, '1204',
          'B1', 'Test Recipient', 'new', 0, 0, uuid_generate_v7())`);
    }
    await expectDbError(
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
        values ('F-bad', '2026-09-29', 'storefront', 'teleport', 'new', 0, 0, uuid_generate_v7())`),
      /orders_fulfillment/,
    );
  });

  test('an entrance delivery needs a building and a recipient name, neither empty', async () => {
    const insert = (building: string | null, name: string | null) =>
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
         status, subtotal_satang, total_satang, client_request_id)
        values ('E-' || uuid_generate_v7(), '2026-09-29', 'storefront', 'entrance_delivery',
          ${building}, ${name}, 'new', 0, 0, uuid_generate_v7())`);
    await insert('B1', 'Test Recipient'); // the room is not needed, the note is optional
    for (const [building, name] of [
      [null, 'Test Recipient'],
      ['B1', null],
      ['', 'Test Recipient'],
      ['B1', ''],
      ['  ', 'Test Recipient'],
      ['B1', '  '],
    ] as const) {
      await expectDbError(insert(building, name), /orders_entrance_delivery_recipient/);
    }
  });

  test('other fulfilments do not need a recipient (platform and legacy orders)', async () => {
    await db.execute(sql`insert into orders
      (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
      values ('G-' || uuid_generate_v7(), '2026-09-29', 'grab', 'platform_delivery', 'new', 0, 0, uuid_generate_v7())`);
  });

  test('room delivery needs a room number', async () => {
    await expectDbError(
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
        values ('L-004', '2026-09-29', 'line', 'room_delivery', 'new', 0, 0, uuid_generate_v7())`),
      /orders_room_delivery_room/,
    );
  });

  test('the client request id makes order creation idempotent', async () => {
    const [o] = await rows<{ client_request_id: string }>(sql`insert into orders
      (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
      values ('S-005', '2026-09-29', 'storefront', 'takeaway', 'preparing', 0, 0, uuid_generate_v7())
      returning client_request_id`);
    await expectDbError(
      db.execute(sql`insert into orders
        (order_no, business_date, channel, fulfillment, status, subtotal_satang, total_satang, client_request_id)
        values ('S-006', '2026-09-29', 'storefront', 'takeaway', 'preparing', 0, 0, ${o?.client_request_id})`),
      /orders_client_request_id_key/,
    );
  });

  test.each(['orders', 'order_items', 'payments', 'expenses', 'audit_log'])(
    'TRUNCATE %s is blocked',
    async (table) => {
      await expectDbError(db.execute(sql.raw(`truncate ${table} cascade`)), /not allowed/);
    },
  );
});
