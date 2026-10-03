import type { LineMessage } from './flex.ts';

export type LineSendResult =
  | { ok: true }
  /** `definite`: LINE answered with a 4xx, so nothing was sent. Otherwise it may have been. */
  | { ok: false; definite: boolean; status?: number };

/** What the sender needs from LINE. Tests pass a fake; production passes `createLineClient`. */
export interface LineClient {
  reply(replyToken: string, messages: LineMessage[]): Promise<LineSendResult>;
  /** `retryKey` (a UUID) lets LINE drop a repeat of the same push. */
  push(to: string, messages: LineMessage[], retryKey?: string): Promise<LineSendResult>;
}

export interface LineClientOptions {
  channelAccessToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** A small fetch wrapper over the Messaging API. The token only ever goes in a header. */
export function createLineClient(options: LineClientOptions): LineClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? 'https://api.line.me';
  const timeoutMs = options.timeoutMs ?? 8000;

  async function post(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<LineSendResult> {
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.channelAccessToken}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { ok: true };
      // A 409 on a retry key means LINE already accepted that push: the first one went out.
      if (response.status === 409) return { ok: true };
      return {
        ok: false,
        definite: response.status >= 400 && response.status < 500,
        status: response.status,
      };
    } catch {
      // Timeout or network error: LINE may or may not have it.
      return { ok: false, definite: false };
    }
  }

  return {
    reply: (replyToken, messages) => post('/v2/bot/message/reply', { replyToken, messages }),
    push: (to, messages, retryKey) =>
      post(
        '/v2/bot/message/push',
        { to, messages },
        retryKey ? { 'x-line-retry-key': retryKey } : {},
      ),
  };
}
