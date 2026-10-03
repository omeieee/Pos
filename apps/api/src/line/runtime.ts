import { type Db, getSettingValue, lineRepo } from '@sds/db';
import {
  createLineClient,
  createLineSender,
  type LineClient,
  type LineSender,
  parseLinePolicy,
  type QuotaStore,
} from '@sds/line';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';

/**
 * The data controller and the contact for data requests named in the Thai privacy notice (owner,
 * 2026-10-03: an individual, "omeie"). Draft for owner review: design/privacy-notice-th.md.
 */
export const PRIVACY_CONTROLLER = 'omeie';
export const PRIVACY_CONTACT_EMAIL = 'omeza25482548@gmail.com';

export interface LineRuntime {
  /** Undefined when LINE_CHANNEL_SECRET is not set: the webhook then answers 503. */
  channelSecret: string | undefined;
  /** Undefined when LINE_CHANNEL_ACCESS_TOKEN is not set: nothing is sent. */
  client: LineClient | null;
  /** Link to the full notice; omitted from messages until one is published. */
  noticeUrl: string | undefined;
  /** Tests wait on this: resolves when every event accepted so far has been processed. */
  idle(): Promise<void>;
  /** Used by the webhook route to register work that continues after the 200 reply. */
  track(work: Promise<unknown>): void;
}

/** The runtime from the environment. Tests pass their own `client` and `channelSecret`. */
export function createLineRuntime(
  line: Pick<Config['line'], 'channelSecret' | 'channelAccessToken'>,
  overrides: { client?: LineClient | null; noticeUrl?: string } = {},
): LineRuntime {
  const pending = new Set<Promise<unknown>>();
  const client =
    overrides.client !== undefined
      ? overrides.client
      : line.channelAccessToken
        ? createLineClient({ channelAccessToken: line.channelAccessToken })
        : null;
  return {
    channelSecret: line.channelSecret,
    client,
    noticeUrl: overrides.noticeUrl,
    track(work) {
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/** The quota books on the real tables (`line_message_log`, `line_quota_months`). */
export function dbQuotaStore(db: Db): QuotaStore {
  return {
    reservePush: (args) => lineRepo.reservePush(db, args),
    releasePush: (args) => lineRepo.releasePush(db, args),
    logReply: (args) => lineRepo.logReply(db, args),
  };
}

export async function readPolicy(db: Db) {
  return parseLinePolicy(await getSettingValue(db, 'line_policy'));
}

/** The one sender every LINE message goes through: replies free, pushes only inside the quota. */
export function buildSender(args: {
  db: Db;
  runtime: LineRuntime;
  events: EventBus;
  now: () => Date;
}): LineSender {
  return createLineSender({
    client: args.runtime.client,
    store: dbQuotaStore(args.db),
    getPolicy: () => readPolicy(args.db),
    now: args.now,
    onThreshold: (level) => {
      // The owner hears about it (Sentry mail, and the staff app once alerts are shown there).
      // Counts only; no customer data.
      args.events.publish({
        type: 'alert.security',
        kind: level === 'cap' ? 'line.quota_capped' : 'line.quota_warning',
        severity: 'warn',
        at: args.now().toISOString(),
        staffId: null,
        deviceId: null,
      });
    },
  });
}
