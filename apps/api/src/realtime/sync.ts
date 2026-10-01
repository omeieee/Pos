/**
 * `GET /v1/sync?since=<rev>&limit=` (D-04, 02 §5): the catch-up path of the realtime protocol. A
 * client that connected, was offline or has just started asks for everything newer than the rev it
 * holds and gets the same frames the WebSocket pushes, oldest first, a page at a time.
 *
 * What a role gets is decided before the database is asked: only the families of rows its
 * permissions open (`familiesFor`), read through the column allow-lists in `@sds/db` (`sync.ts`),
 * then every row is rebuilt as a frame by the same mappers the events use. `nextSince` is the rev
 * of the last row READ, whether or not the role could see it as a frame, so paging always moves.
 */
import { syncRepo } from '@sds/db';
import { type SyncChange, type SyncResponse, syncQuerySchema } from '@sds/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext, Principal } from '../auth/service.ts';
import { parse } from '../validate.ts';
import { familiesFor, frameFromEntry, mayReceive } from './frames.ts';

export async function catchUp(
  ctx: AuthContext,
  principal: Principal,
  rawQuery: unknown,
  log: FastifyBaseLogger,
): Promise<SyncResponse> {
  const { since, limit } = parse(syncQuerySchema, rawQuery);
  const batch = await syncRepo.readChanges(ctx.db, {
    since,
    limit,
    include: familiesFor(principal.role),
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
  return {
    changes,
    nextSince: last ? last.rev : since,
    hasMore: batch.hasMore,
    // Read after the page, so it is never below `nextSince`.
    serverRev: await syncRepo.currentRev(ctx.db),
  };
}
