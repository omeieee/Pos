import { insertAudit, schema } from '@sds/db';
import { createPgliteDb, type PgliteDb } from '@sds/db/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type AppEvent, createEventBus } from './events.ts';
import { withTransaction } from './tx.ts';

let db: PgliteDb;
let close: () => Promise<void>;
beforeAll(async () => {
  const made = await createPgliteDb();
  db = made.db;
  close = () => made.client.close();
}, 60_000);
afterAll(async () => {
  await close();
});

const event: AppEvent = {
  type: 'alert.security',
  kind: 'test',
  severity: 'info',
  at: '2026-10-01T03:00:00.000Z',
  staffId: null,
  deviceId: null,
};

const auditCount = async (entityId: string) =>
  (await db.select().from(schema.auditLog)).filter((r) => r.entityId === entityId).length;

describe('withTransaction', () => {
  test('publishes events only after the transaction has committed', async () => {
    const bus = createEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => void seen.push(e));
    const id = crypto.randomUUID();

    await withTransaction({ db, events: bus }, async (tx, emit) => {
      await insertAudit(tx, { actorType: 'system', action: 'test', entity: 'test', entityId: id });
      emit(event);
      expect(seen, 'nothing is published while the transaction is open').toHaveLength(0);
    });
    expect(seen).toHaveLength(1);
    expect(await auditCount(id)).toBe(1);
  });

  test('publishes nothing and keeps nothing when the work fails', async () => {
    const bus = createEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => void seen.push(e));
    const id = crypto.randomUUID();

    await expect(
      withTransaction({ db, events: bus }, async (tx, emit) => {
        await insertAudit(tx, {
          actorType: 'system',
          action: 'test',
          entity: 'test',
          entityId: id,
        });
        emit(event);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toHaveLength(0);
    expect(await auditCount(id)).toBe(0);
  });

  test('returns what the work returns', async () => {
    const result = await withTransaction({ db, events: createEventBus() }, async () => 42);
    expect(result).toBe(42);
  });
});
