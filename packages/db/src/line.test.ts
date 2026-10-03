import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as lineRepo from './line.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let client: PGlite;
let db: PgliteDb;
beforeAll(async () => {
  ({ client, db } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

describe('migration 0019: stored events lose their raw payload', () => {
  test('existing rows keep a minimal route and lose the payload (chat text)', async () => {
    // Rows as the old code stored them. Made-up ids and text only.
    const old = (id: string, type: string, payload: unknown, userId: string | null) =>
      client.query(
        'insert into line_events (webhook_event_id, type, user_id, payload) values ($1, $2, $3, $4::jsonb)',
        [id, type, userId, JSON.stringify(payload)],
      );
    await old('m-follow', 'follow', { type: 'follow', replyToken: 'rt-secret' }, 'Utest-m1');
    await old('m-unfollow', 'unfollow', { type: 'unfollow' }, 'Utest-m1');
    await old(
      'm-ack',
      'postback',
      { postback: { data: 'action=ack_privacy' }, replyToken: 'rt-secret' },
      'Utest-m1',
    );
    await old(
      'm-text',
      'message',
      { message: { type: 'text', text: 'ห้อง 1203 โทร 0812345678' } },
      'Utest-m1',
    );
    await old('m-nouser', 'follow', { type: 'follow' }, null);

    // Run the migration's data statements again (the schema part already ran).
    const sql = readFileSync(
      new URL('../migrations/0019_line_events_minimal.sql', import.meta.url),
      'utf8',
    );
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (/^\s*(--[^\n]*\n\s*)*UPDATE/i.test(statement)) await client.query(statement);
    }

    const rows = await client.query<{
      webhook_event_id: string;
      payload: unknown;
      route: Record<string, string>;
    }>('select webhook_event_id, payload, route from line_events where webhook_event_id like $1', [
      'm-%',
    ]);
    const byId = new Map(rows.rows.map((r) => [r.webhook_event_id, r]));
    expect(byId.get('m-follow')?.route).toEqual({ kind: 'follow', userId: 'Utest-m1' });
    expect(byId.get('m-unfollow')?.route).toEqual({ kind: 'unfollow', userId: 'Utest-m1' });
    expect(byId.get('m-ack')?.route).toEqual({ kind: 'ack_privacy', userId: 'Utest-m1' });
    expect(byId.get('m-text')?.route).toEqual({ kind: 'ignore' });
    expect(byId.get('m-nouser')?.route).toEqual({ kind: 'ignore' });
    for (const r of rows.rows) expect(r.payload).toBeNull();
    expect(JSON.stringify(rows.rows)).not.toContain('0812345678');
    expect(JSON.stringify(rows.rows)).not.toContain('rt-secret');
  });
});

describe('acknowledgePrivacy records the notice version', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 4, minute, 0));
  const ack = async (user: string) =>
    (
      await client.query<{ privacy_ack_at: Date | null; privacy_ack_version: string | null }>(
        'select privacy_ack_at, privacy_ack_version from customers where line_user_id = $1',
        [user],
      )
    ).rows[0];

  test('the first acknowledgement stores the time and the version, creating the customer', async () => {
    await lineRepo.acknowledgePrivacy(db, 'Utest-ack-v1', at(1), 'v1');
    expect(await ack('Utest-ack-v1')).toEqual({
      privacy_ack_at: at(1),
      privacy_ack_version: 'v1',
    });
  });

  test('the same version again keeps the first time', async () => {
    const id = await lineRepo.acknowledgePrivacy(db, 'Utest-ack-v1', at(30), 'v1');
    expect(id).toBeTruthy();
    expect(await ack('Utest-ack-v1')).toEqual({
      privacy_ack_at: at(1),
      privacy_ack_version: 'v1',
    });
  });

  test('a newer notice version replaces both the time and the version', async () => {
    await lineRepo.acknowledgePrivacy(db, 'Utest-ack-v1', at(45), 'v2');
    expect(await ack('Utest-ack-v1')).toEqual({
      privacy_ack_at: at(45),
      privacy_ack_version: 'v2',
    });
  });

  test('an acknowledgement stored before versions existed is replaced by the first versioned one', async () => {
    await client.query('insert into customers (line_user_id, privacy_ack_at) values ($1, $2)', [
      'Utest-ack-old',
      at(2).toISOString(),
    ]);
    await lineRepo.acknowledgePrivacy(db, 'Utest-ack-old', at(50), 'v1');
    expect(await ack('Utest-ack-old')).toEqual({
      privacy_ack_at: at(50),
      privacy_ack_version: 'v1',
    });
  });
});
