/**
 * `GET /v1/sync?since=<rev>&limit=` (D-04, 02 §5): the catch-up path of the realtime protocol. A
 * client that connected, was offline or has just started asks for everything newer than the rev it
 * holds and gets the same frames the WebSocket pushes, oldest first, a page at a time.
 *
 * What a role gets is decided before the database is asked: only the families of rows its
 * permissions open (`familiesFor`), read through the column allow-lists in `@sds/db` (`sync.ts`),
 * then every row is rebuilt as a frame by the same mappers the events use. `nextSince` is the rev
 * of the last row READ, whether or not the role could see it as a frame, so paging always moves.
 *
 * THE FIRST CATCH-UP IS BOUNDED. A fresh device (`since=0`) gets, for orders (with their lines) and
 * payments, only what matters now: the orders of the current business day, every open order, every
 * order with a pending or claimed payment, and the payments of those orders. Menu, settings,
 * customers and the other tables stay complete. Older, settled orders are not in the first
 * catch-up; they stay available through the REST routes. The frame shape, paging, `nextSince`
 * and `serverRev` are unchanged, so a client needs nothing new.
 *
 * Why this needs memory: a client follows `nextSince` for page 2 onward, so page 2 is an ordinary
 * `since>0` request, and a resuming device (`since>0`) must still get EVERY later change, including
 * to an old order (a void of yesterday's order). The server therefore remembers, per session and
 * for a short time, that a bounded chain is in progress and which `since` it expects next; only
 * that exact request continues the bounded read, with the window fixed on page 1 (the business
 * day and `headRev`, the newest rev when the chain began). Rows above `headRev` always travel, so
 * an old open order that is finished between two pages still arrives, as finished.
 *
 * What is NOT bounded: any `since>0` request that is not the next page of a chain (it is the
 * normal, complete feed), and a chain whose memory was lost (restart, time-out): it falls back to
 * the complete feed, which means more rows, never a missed update. `since=1` therefore still pages
 * the whole history: this bound lowers the cost of a fresh device, it is not an access control.
 * A client that clamps its rewound cursor to 0 (`lastRev` at or below `SYNC_SAFETY_REVS`) is
 * treated as fresh.
 */
import { syncRepo } from '@sds/db';
import { type SyncChange, type SyncResponse, syncQuerySchema } from '@sds/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext, Principal } from '../auth/service.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { parse } from '../validate.ts';
import { familiesFor, frameFromEntry, mayReceive } from './frames.ts';

/** How long a bounded chain waits for its next page. A page is a few queries; this is generous. */
const CHAIN_TTL_MS = 2 * 60_000;

interface Chain {
  /** The only `since` that continues the chain: the `nextSince` it last returned. */
  expectSince: number;
  window: syncRepo.SyncWindow;
  expiresAt: number;
}

export type CatchUp = (
  principal: Principal,
  rawQuery: unknown,
  log: FastifyBaseLogger,
) => Promise<SyncResponse>;

export function createCatchUp(ctx: AuthContext): CatchUp {
  /** In memory, one chain per session. Lost on restart, which only makes the next page unbounded. */
  const chains = new Map<string, Chain>();

  return async function catchUp(principal, rawQuery, log) {
    const { since, limit } = parse(syncQuerySchema, rawQuery);
    const now = ctx.now().getTime();
    for (const [sessionId, chain] of chains) if (chain.expiresAt <= now) chains.delete(sessionId);

    let window: syncRepo.SyncWindow | undefined;
    if (since === 0) {
      // The head first: a row written after this moment always travels, whatever it is.
      const headRev = await syncRepo.currentRev(ctx.db);
      window = { headRev, businessDate: await currentBusinessDate(ctx.db, ctx.now()) };
    } else {
      const chain = chains.get(principal.sessionId);
      if (chain && chain.expectSince === since) window = chain.window;
    }

    const batch = await syncRepo.readChanges(ctx.db, {
      since,
      limit,
      include: familiesFor(principal.role),
      ...(window ? { window } : {}),
    });

    const changes: SyncChange[] = [];
    for (const entry of batch.entries) {
      const frame = frameFromEntry(entry);
      if (!frame) {
        // The kind and rev only: never the row. The page goes on without it.
        log.error(
          { kind: entry.kind, rev: entry.rev },
          'sync row dropped: it does not fit its frame',
        );
        continue;
      }
      if (mayReceive(principal.role, frame)) changes.push(frame);
    }
    const last = batch.entries[batch.entries.length - 1];
    if (window) {
      if (batch.hasMore && last) {
        chains.set(principal.sessionId, {
          expectSince: last.rev,
          window,
          expiresAt: now + CHAIN_TTL_MS,
        });
      } else {
        chains.delete(principal.sessionId);
      }
    }
    return {
      changes,
      nextSince: last ? last.rev : since,
      hasMore: batch.hasMore,
      // Read after the page, so it is never below `nextSince`.
      serverRev: await syncRepo.currentRev(ctx.db),
    };
  };
}
