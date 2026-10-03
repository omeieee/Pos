import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPgliteDb } from './pglite.ts';

let client: PGlite;
beforeAll(async () => {
  ({ client } = await createPgliteDb());
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
