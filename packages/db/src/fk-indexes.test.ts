/**
 * Migration 0009 adds covering indexes for foreign keys the Supabase advisor listed. These tests
 * upgrade a database that is at migration 0008 and already holds rows, and check that no foreign
 * key in the schema is left without an index.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MIGRATIONS_DIR } from './client.ts';

/** The 13 columns from the advisor's list: table.column. */
const ADVISOR_COLUMNS = [
  'audit_log.device_id',
  'expenses.created_by_staff_id',
  'line_message_log.customer_id',
  'line_message_log.order_id',
  'menu_item_modifier_groups.group_id',
  'menu_items.category_id',
  'modifier_options.group_id',
  'order_items.menu_item_id',
  'orders.created_by_staff_id',
  'orders.created_on_device_id',
  'payments.confirmed_by_staff_id',
  'payments.scheme_id',
  'settings.updated_by',
];

/** A copy of the migrations folder that stops after 0008 (what production had before 0009). */
function folderUpTo0008(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sds-mig-'));
  mkdirSync(join(dir, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((e) => e.idx <= 8);
  for (const e of kept) cpSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return dir;
}

let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder: folderUpTo0008() });
}, 60_000);
afterAll(async () => {
  await client.close();
});

/** Foreign keys whose column list is not the leading part of any index on the table. */
async function unindexedForeignKeys(): Promise<string[]> {
  const res = await client.query<{ fk: string }>(`
    select c.conrelid::regclass::text || '.' || string_agg(a.attname, ',' order by k.ord) as fk
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    group by c.oid, c.conrelid, c.conkey
    having not exists (
      select 1 from pg_index i
      where i.indrelid = c.conrelid
        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
    )
    order by 1`);
  return res.rows.map((r) => r.fk);
}

describe('upgrading from migration 0008', () => {
  test('before 0009, the advisor columns have no covering index', async () => {
    const open = await unindexedForeignKeys();
    for (const column of ADVISOR_COLUMNS) expect(open, column).toContain(column);
  });

  test('0009 applies over existing rows and keeps them', async () => {
    // Rows in tables the new indexes touch, written while the database is at 0008.
    const staff = (
      await client.query<{ id: string }>(
        `insert into staff (display_name, role) values ('เก่า', 'cashier') returning id`,
      )
    ).rows[0]?.id;
    const device = (
      await client.query<{ id: string }>(
        `insert into devices (name, kind, token_hash) values ('iPad', 'ipad', 'old-hash') returning id`,
      )
    ).rows[0]?.id;
    const category = (
      await client.query<{ id: string }>(
        `insert into menu_categories (name_th) values ('หมวดเก่า') returning id`,
      )
    ).rows[0]?.id;
    const item = (
      await client.query<{ id: string }>(
        `insert into menu_items (category_id, name_th, price_satang) values ($1, 'เมนูเก่า', 5000) returning id`,
        [category],
      )
    ).rows[0]?.id;
    const order = (
      await client.query<{ id: string }>(
        `insert into orders (order_no, business_date, channel, fulfillment, status, subtotal_satang,
         total_satang, client_request_id, created_by_staff_id, created_on_device_id)
       values ('S-001', '2026-09-30', 'storefront', 'takeaway', 'preparing', 5000, 5000,
         uuid_generate_v7(), $1, $2) returning id`,
        [staff, device],
      )
    ).rows[0]?.id;
    await client.query(
      `insert into order_items (order_id, menu_item_id, name_th_snapshot, unit_price_satang, qty, line_total_satang)
       values ($1, $2, 'เมนูเก่า', 5000, 1, 5000)`,
      [order, item],
    );
    await client.query(
      `insert into audit_log (actor_type, action, entity, device_id) values ('system', 'old.row', 'x', $1)`,
      [device],
    );

    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_DIR });

    const counts = (
      await client.query<Record<string, number>>(
        `select (select count(*)::int from orders) as orders,
              (select count(*)::int from order_items) as items,
              (select count(*)::int from audit_log where action = 'old.row') as audit,
              (select count(*)::int from menu_items) as menu`,
      )
    ).rows[0];
    expect(counts).toEqual({ orders: 1, items: 1, audit: 1, menu: 1 });
  });

  test('after 0009 every advisor column is covered', async () => {
    const open = await unindexedForeignKeys();
    for (const column of ADVISOR_COLUMNS) expect(open, column).not.toContain(column);
  });

  test('after 0009 no foreign key in the schema is left without an index', async () => {
    expect(await unindexedForeignKeys()).toEqual([]);
  });

  test('running the migrations again changes nothing', async () => {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_DIR });
    expect(await unindexedForeignKeys()).toEqual([]);
  });

  test('0009 uses IF NOT EXISTS, so it also applies where an index was added by hand', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0009_fk_covering_indexes.sql'), 'utf8');
    const creates = sql.match(/CREATE INDEX/gi) ?? [];
    expect(creates).toHaveLength(13);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/gi) ?? []).toHaveLength(13);
  });
});
