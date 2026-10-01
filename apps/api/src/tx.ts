import type { Db } from '@sds/db';
import type { AppEvent, EventBus } from './events.ts';

export type Emit = (event: AppEvent) => void;

/**
 * One database transaction per write (CLAUDE.md rule 6). Events collected with `emit` are
 * published only after the transaction commits; if it throws, nothing is published.
 * Expected failures (a wrong PIN) must be returned, not thrown, so their counters still commit.
 */
export async function withTransaction<T>(
  ctx: { db: Db; events: EventBus },
  work: (tx: Db, emit: Emit) => Promise<T>,
): Promise<T> {
  const pending: AppEvent[] = [];
  const result = await ctx.db.transaction((tx) => work(tx, (event) => pending.push(event)));
  for (const event of pending) ctx.events.publish(event);
  return result;
}
