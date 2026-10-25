/**
 * Test seam for the Telegram Bot API: a transport that records every call (no network) and
 * answers from a script. The call's method is read from the URL the notifier built, so the bot
 * token stays out of what a test inspects unless it looks for it.
 */
import type { TelegramReply, TelegramTransport } from '../telegram/notifier.ts';

export interface TelegramCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

export type TelegramOutcome = TelegramReply | 'throw' | 'hang';

export interface FakeTelegram {
  transport: TelegramTransport;
  calls: TelegramCall[];
  /** Answers for one method, in order; the last one repeats. Default: ok. */
  script(method: string, ...outcomes: TelegramOutcome[]): void;
  callsTo(method: string): TelegramCall[];
  reset(): void;
}

export const OK: TelegramReply = { status: 200, body: { ok: true, result: {} } };

export function createFakeTelegram(): FakeTelegram {
  const calls: TelegramCall[] = [];
  const scripts = new Map<string, TelegramOutcome[]>();
  const used = new Map<string, number>();
  return {
    calls,
    transport: async (url, body, signal) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push({ method, url, body: body as Record<string, unknown> });
      const list = scripts.get(method) ?? [OK];
      const index = Math.min(used.get(method) ?? 0, list.length - 1);
      used.set(method, (used.get(method) ?? 0) + 1);
      const outcome = list[index] ?? OK;
      if (outcome === 'throw') throw new TypeError(`fetch failed for ${url}`);
      if (outcome === 'hang') {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return outcome === 'hang' ? { status: 0, body: null } : outcome;
    },
    script: (method, ...outcomes) => void scripts.set(method, outcomes),
    callsTo: (method) => calls.filter((c) => c.method === method),
    reset() {
      calls.length = 0;
      scripts.clear();
      used.clear();
    },
  };
}
