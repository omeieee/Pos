import { type Db, lineRepo } from '@sds/db';
import type { LineSender } from '@sds/line';
import type { EventBus } from '../events.ts';
import { handleEvent } from './handlers.ts';
import { buildSender, type LineRuntime } from './runtime.ts';
import { fromStoredRoute, storedRouteSchema } from './stored-route.ts';

/** Sweep limits for events that were stored but not handled, or handled with an error. */
export const LINE_EVENT_RETRY = {
  /** Younger events may still be in the live handler that runs right after the 200. */
  minAgeMinutes: 2,
  /** Older events are given up: what they asked for no longer matters. */
  maxAgeMinutes: 24 * 60,
  /** Tries by the sweep, not counting the live run. */
  maxAttempts: 5,
  limit: 50,
} as const;

export interface LineJobDeps {
  db: Db;
  events: EventBus;
  now: () => Date;
  line: LineRuntime;
}

export interface RetryResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /** Follow or unfollow events that a later one replaced: marked handled without running. */
  superseded: number;
}

/**
 * Runs again the events that never finished (the process stopped after the 200, or a handler
 * failed). Safe to repeat: every handler is idempotent, `attempts` caps the tries, and the sweep
 * never answers the customer (its reply token expired) so it spends no quota. Each event runs
 * with the time LINE delivered it, so a retried unfollow or acknowledgement is dated correctly.
 * Failures are recorded by class name only. Call it on a timer; it does not loop by itself.
 */
export async function retryLineEvents(
  deps: LineJobDeps,
  options: { limit?: number } = {},
): Promise<RetryResult> {
  const now = deps.now();
  const claimed = await lineRepo.claimRetryableEvents(deps.db, {
    receivedBefore: new Date(now.getTime() - LINE_EVENT_RETRY.minAgeMinutes * 60_000),
    receivedAfter: new Date(now.getTime() - LINE_EVENT_RETRY.maxAgeMinutes * 60_000),
    maxAttempts: LINE_EVENT_RETRY.maxAttempts,
    limit: options.limit ?? LINE_EVENT_RETRY.limit,
  });
  const result: RetryResult = { claimed: claimed.length, succeeded: 0, failed: 0, superseded: 0 };
  const sender = noReply(
    buildSender({ db: deps.db, runtime: deps.line, events: deps.events, now: deps.now }),
  );

  for (const event of claimed) {
    let failure: string | undefined;
    let ran = true;
    try {
      const route = storedRouteSchema.parse(event.route);
      if (
        (route.kind === 'follow' || route.kind === 'unfollow') &&
        (await lineRepo.hasLaterFollowEvent(deps.db, {
          webhookEventId: event.webhookEventId,
          userId: route.userId,
          receivedAt: event.receivedAt,
        }))
      ) {
        result.superseded += 1;
        ran = false;
      } else {
        await handleEvent(
          {
            db: deps.db,
            sender,
            now: () => event.receivedAt,
            events: deps.events,
            liffUrl: deps.line.liffUrl,
            noticeUrl: deps.line.noticeUrl,
            privacy: deps.line.privacy,
          },
          fromStoredRoute(route),
        );
      }
    } catch (error) {
      // Class name only: an error message can carry a user id or text.
      failure = error instanceof Error ? error.name : 'Error';
    }
    if (failure !== undefined) result.failed += 1;
    else if (ran) result.succeeded += 1;
    await lineRepo.markEventProcessed(deps.db, event.webhookEventId, deps.now(), failure);
  }
  return result;
}

/** A retry has no live reply token, so its replies are skipped. Pushes still go through the quota. */
function noReply(sender: LineSender): LineSender {
  return {
    reply: async () => ({ sent: false, reason: 'failed' }),
    push: (to, messages, meta) => sender.push(to, messages, meta),
  };
}
