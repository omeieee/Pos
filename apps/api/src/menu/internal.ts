/**
 * Menu: what the other menu files share (kinds, error shapes, diff helpers, publish, idempotent create).
 * Imports nothing from its siblings, so no import cycle can start here.
 */
import { type Db, menuRepo } from '@sds/db';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, conflict } from '../errors.ts';
import type { Emit } from '../tx.ts';

type MenuKind = 'category' | 'item' | 'group' | 'option';

export const unknownCategory = () =>
  new ApiError(422, 'UNKNOWN_CATEGORY', 'That category does not exist');
export const unknownGroup = () =>
  new ApiError(422, 'UNKNOWN_GROUP', 'A modifier group does not exist or has been removed');

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The channel price overrides as a plain channel -> satang record (no undefined entries). */
export function priceRecord(prices: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(prices).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

/** Fields whose value differs, as before/after objects for the audit row. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!same(before[key], after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

export function publish(emit: Emit, kind: MenuKind, id: string, rev: number, data: unknown) {
  emit({ type: 'menu.upserted', kind, id, rev, data });
}

// ---------- Idempotent creates ----------

/** A create's answer. `replay` is true when the request id was seen before: nothing was written. */
export interface Created<T> {
  dto: T;
  replay: boolean;
}

/**
 * Runs a create that may carry a client request id (CLAUDE.md rule 6, mirroring orders). Without
 * one, it just creates. With one: a row already made for that id is returned (same content) or
 * refused (other content); otherwise `create` runs, and if it loses a race to a concurrent request
 * with the same id (`DuplicateClientRequest`, its transaction rolled back with no audit row and no
 * event) the winner is read and treated the same way. A replay writes, audits and publishes nothing.
 */
export async function idempotentCreate<Row extends { requestHash: string | null }, Dto>(
  ctx: AuthContext,
  key: string | undefined,
  requestHash: string,
  find: (db: Db, key: string) => Promise<Row | undefined>,
  toDto: (db: Db, row: Row) => Promise<Dto>,
  create: () => Promise<Dto>,
): Promise<Created<Dto>> {
  if (key === undefined) return { dto: await create(), replay: false };
  const replayOf = async (row: Row): Promise<Created<Dto>> => {
    if (row.requestHash !== null && row.requestHash !== requestHash) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This request id was already used for different content. Make a new request id for a new menu row',
      );
    }
    return { dto: await toDto(ctx.db, row), replay: true };
  };
  const existing = await find(ctx.db, key);
  if (existing) return replayOf(existing);
  try {
    return { dto: await create(), replay: false };
  } catch (error) {
    if (!(error instanceof menuRepo.DuplicateClientRequest)) throw error;
    const winner = await find(ctx.db, key);
    if (!winner) throw error;
    return replayOf(winner);
  }
}

export const requestKey = (key: string | undefined, requestHash: string) =>
  key === undefined ? {} : { clientRequestId: key, requestHash };

export const actorOf = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});
