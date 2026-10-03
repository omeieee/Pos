import { type Db, getSettingValue, lineRepo } from '@sds/db';
import {
  createLineClient,
  createLineSender,
  type LineClient,
  type LineSender,
  parseLinePolicy,
  type QuotaStore,
} from '@sds/line';
import { type Config, DEFAULT_PRIVACY } from '../config.ts';
import type { EventBus } from '../events.ts';
import { createLiffVerifier, type LiffVerifier, liffChannelId } from './liff-verify.ts';

export interface LineRuntime {
  /** Undefined when LINE_CHANNEL_SECRET is not set: the webhook then answers 503. */
  channelSecret: string | undefined;
  /** Undefined when LINE_CHANNEL_ACCESS_TOKEN is not set: nothing is sent. */
  client: LineClient | null;
  /** Link to the full notice; omitted from messages until one is published. */
  noticeUrl: string | undefined;
  /**
   * The customer app's address inside LINE (`https://liff.line.me/<LINE_LIFF_ID>`): the base of
   * every link a chat card carries. Undefined when LINE_LIFF_ID is not set, and then the cards
   * that need it are not sent.
   */
  liffUrl: string | undefined;
  /** Checks a customer's LIFF token with LINE. Null without a valid LINE_LIFF_ID: the app cannot sign in. */
  liffVerifier: LiffVerifier | null;
  /** The controller and contact the privacy notice names (`PRIVACY_*` environment variables). */
  privacy: { controller: string; contactEmail: string };
  /** Tests wait on this: resolves when every event accepted so far has been processed. */
  idle(): Promise<void>;
  /** Used by the webhook route to register work that continues after the 200 reply. */
  track(work: Promise<unknown>): void;
}

/** The runtime from the environment. Tests pass their own `client` and `channelSecret`. */
export function createLineRuntime(
  line: Pick<Config['line'], 'channelSecret' | 'channelAccessToken'> &
    Partial<Pick<Config['line'], 'liffId'>>,
  overrides: {
    client?: LineClient | null;
    liffVerifier?: LiffVerifier | null;
    noticeUrl?: string;
    privacy?: LineRuntime['privacy'];
  } = {},
): LineRuntime {
  const pending = new Set<Promise<unknown>>();
  const client =
    overrides.client !== undefined
      ? overrides.client
      : line.channelAccessToken
        ? createLineClient({ channelAccessToken: line.channelAccessToken })
        : null;
  const channelId = liffChannelId(line.liffId);
  const liffVerifier =
    overrides.liffVerifier !== undefined
      ? overrides.liffVerifier
      : channelId
        ? createLiffVerifier({ channelId })
        : null;
  return {
    channelSecret: line.channelSecret,
    client,
    liffUrl: channelId && line.liffId ? `https://liff.line.me/${line.liffId}` : undefined,
    liffVerifier,
    noticeUrl: overrides.noticeUrl,
    privacy: overrides.privacy ?? DEFAULT_PRIVACY,
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
export function dbQuotaStore(db: Db, now: () => Date = () => new Date()): QuotaStore {
  return {
    reservePush: (args) => lineRepo.reservePush(db, args),
    releasePush: (args) => lineRepo.releasePush(db, args),
    logReply: (args) => lineRepo.logReply(db, args),
    claimAlert: (args) => lineRepo.claimQuotaAlert(db, { ...args, at: now() }),
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
    store: dbQuotaStore(args.db, args.now),
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
