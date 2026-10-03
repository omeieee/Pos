import type { LineClient } from './client.ts';
import type { LineMessage } from './flex.ts';
import { type LinePolicy, quotaMonth, thresholdCrossed } from './policy.ts';

/** Where the sender keeps its books. `apps/api` implements it on `line_message_log` and the month counter. */
export interface QuotaStore {
  /**
   * Atomically: log the push (counted) and take one unit of the month's quota. `capped` when the
   * month already holds `limit`; `duplicate` when this order already has a push for `template`.
   */
  reservePush(args: {
    month: string;
    limit: number;
    template: string;
    customerId?: string;
    orderId?: string;
  }): Promise<
    | { status: 'reserved'; used: number; logId: string }
    | { status: 'capped' }
    | { status: 'duplicate' }
  >;
  /** Gives the unit back and removes the log row (LINE definitely refused the push). */
  releasePush(args: { month: string; logId: string }): Promise<void>;
  logReply(args: { template: string; customerId?: string; orderId?: string }): Promise<void>;
}

export type SendOutcome =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'not_configured'
        | 'policy_off'
        | 'not_essential'
        | 'quota_exhausted'
        | 'duplicate'
        | 'failed';
    };

export interface SenderOptions {
  /** `null` when the LINE_* variables are not set. Nothing is sent then. */
  client: LineClient | null;
  store: QuotaStore;
  getPolicy: () => Promise<LinePolicy>;
  now?: () => Date;
  /** Called once as the month reaches the warning level and again at the limit. */
  onThreshold?: (level: 'warn' | 'cap', used: number, limit: number) => void;
}

export interface Meta {
  template: string;
  customerId?: string;
  orderId?: string;
}

export interface LineSender {
  /** Free. Always allowed (policy and quota do not apply), but logged as uncounted. */
  reply(replyToken: string, messages: LineMessage[], meta: Meta): Promise<SendOutcome>;
  /**
   * Costs one message of the monthly quota. `essential` marks the pushes the `essential` policy
   * still allows ("ready + receipt"). The caller falls back to a free reply or the live status
   * page when `sent` is false.
   */
  push(
    to: string,
    messages: LineMessage[],
    meta: Meta & { essential: boolean },
  ): Promise<SendOutcome>;
}

export function createLineSender(options: SenderOptions): LineSender {
  const now = options.now ?? (() => new Date());

  return {
    async reply(replyToken, messages, meta) {
      if (!options.client) return { sent: false, reason: 'not_configured' };
      const result = await options.client.reply(replyToken, messages);
      if (!result.ok) return { sent: false, reason: 'failed' };
      // The reply went out; a bookkeeping failure must not turn it into an error.
      await options.store.logReply(meta).catch(() => undefined);
      return { sent: true };
    },

    async push(to, messages, meta) {
      if (!options.client) return { sent: false, reason: 'not_configured' };
      const policy = await options.getPolicy();
      if (policy.push === 'off') return { sent: false, reason: 'policy_off' };
      if (policy.push === 'essential' && !meta.essential) {
        return { sent: false, reason: 'not_essential' };
      }

      const month = quotaMonth(now());
      const reserved = await options.store.reservePush({
        month,
        limit: policy.monthlyLimit,
        template: meta.template,
        ...(meta.customerId ? { customerId: meta.customerId } : {}),
        ...(meta.orderId ? { orderId: meta.orderId } : {}),
      });
      if (reserved.status === 'capped') return { sent: false, reason: 'quota_exhausted' };
      if (reserved.status === 'duplicate') return { sent: false, reason: 'duplicate' };

      const level = thresholdCrossed(reserved.used, policy);
      if (level) options.onThreshold?.(level, reserved.used, policy.monthlyLimit);

      const result = await options.client.push(to, messages, reserved.logId);
      if (result.ok) return { sent: true };
      // A 4xx means LINE did not send it: give the unit back. A timeout or 5xx may have been
      // delivered, so the unit stays spent (the count errs on the safe side).
      if (result.definite) {
        await options.store.releasePush({ month, logId: reserved.logId }).catch(() => undefined);
      }
      return { sent: false, reason: 'failed' };
    },
  };
}
