import type { AuditActorType } from '@sds/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { auditLog } from './schema.ts';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  deviceId?: string | null;
  /** Dotted verb, e.g. `device.register`. */
  action: string;
  entity: string;
  entityId?: string | null;
  /** Never put secrets (PIN, password, token, TOTP) in `before` or `after`. */
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Appends one audit row. Call it on the transaction of the change it describes. */
export async function insertAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    deviceId: entry.deviceId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
  });
}

/**
 * The audit row of an entity whose `after` carries this `clientRequestId`: how a route that
 * records only in the audit log recognises a retry. Call it under the lock of the entity.
 */
export async function findAuditByRequestId(
  db: Db,
  entity: string,
  entityId: string,
  clientRequestId: string,
): Promise<{ action: string; after: unknown } | undefined> {
  const [row] = await db
    .select({ action: auditLog.action, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, entity),
        eq(auditLog.entityId, entityId),
        sql`${auditLog.after}->>'clientRequestId' = ${clientRequestId}`,
      ),
    )
    .limit(1);
  return row;
}
