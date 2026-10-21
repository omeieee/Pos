/**
 * Queries for Web Push subscriptions (P8 phone alerts): one row per device. The endpoint and keys
 * leave this module only for the sender; no API route returns them.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { devices, pushSubscriptions } from './schema.ts';

export interface PushSubscriptionRow {
  id: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
  lastSuccessAt: Date | null;
}

export interface UpsertPushSubscription {
  deviceId: string;
  staffId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  now: Date;
}

/**
 * Saves the device's subscription (one per device; a new one replaces the old and clears the
 * failure count). A browser that was registered as another device before keeps one row only: the
 * other device's row with the same endpoint is removed.
 */
export async function upsertForDevice(db: Db, input: UpsertPushSubscription): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, input.endpoint),
        ne(pushSubscriptions.deviceId, input.deviceId),
      ),
    );
  await db
    .insert(pushSubscriptions)
    .values({
      deviceId: input.deviceId,
      staffId: input.staffId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.deviceId,
      set: {
        staffId: input.staffId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        failureCount: 0,
      },
    });
}

/** True when a row was removed. */
export async function deleteForDevice(db: Db, deviceId: string): Promise<boolean> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.deviceId, deviceId))
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

export async function existsForDevice(db: Db, deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.deviceId, deviceId))
    .limit(1);
  return row !== undefined;
}

export async function deleteById(db: Db, id: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

/** Every subscription whose device is not revoked: who a new-order alert goes to. */
export async function listDeliverable(db: Db): Promise<PushSubscriptionRow[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      deviceId: pushSubscriptions.deviceId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      failureCount: pushSubscriptions.failureCount,
      lastSuccessAt: pushSubscriptions.lastSuccessAt,
    })
    .from(pushSubscriptions)
    .innerJoin(devices, eq(devices.id, pushSubscriptions.deviceId))
    .where(isNull(devices.revokedAt));
}

export async function markSuccess(db: Db, id: string, now: Date): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ lastSuccessAt: now, failureCount: 0 })
    .where(eq(pushSubscriptions.id, id));
}

/** Counts one failed send; at `maxFailures` the subscription is deleted. */
export async function recordFailure(
  db: Db,
  id: string,
  maxFailures: number,
): Promise<'kept' | 'dropped'> {
  const [row] = await db
    .update(pushSubscriptions)
    .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
    .where(eq(pushSubscriptions.id, id))
    .returning({ failureCount: pushSubscriptions.failureCount });
  if (row && row.failureCount >= maxFailures) {
    await deleteById(db, id);
    return 'dropped';
  }
  return 'kept';
}
