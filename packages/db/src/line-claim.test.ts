import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

describe('claimRetryableEvents', () => {
  test('selects its candidates with FOR UPDATE SKIP LOCKED and takes only the oldest `limit`', async () => {
    for (const [id, minutes] of [
      ['claim-a', 50],
      ['claim-b', 40],
      ['claim-c', 30],
    ] as const) {
      await client.query(
        `insert into line_events (webhook_event_id, type, user_id, route, received_at)
         values ($1, 'follow', 'Utest-claim', '{"kind":"ignore"}'::jsonb, now() - make_interval(mins => $2))`,
        [id, minutes],
      );
    }
    const spy = vi.spyOn(client, 'query');
    const claimed = await lineRepo.claimRetryableEvents(db, {
      receivedBefore: new Date(Date.now() - 60_000),
      receivedAfter: new Date(Date.now() - 86_400_000),
      maxAttempts: 5,
      limit: 2,
    });
    const sqlText = spy.mock.calls.map((c) => String(c[0]).toLowerCase()).join('\n');
    spy.mockRestore();
    expect(sqlText).toContain('for update skip locked');
    expect(claimed.map((c) => c.webhookEventId)).toEqual(['claim-a', 'claim-b']);
  });
});
