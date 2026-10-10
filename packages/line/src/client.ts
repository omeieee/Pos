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
  /**
   * The bytes of an image, video or audio message the bot received, up to `maxBytes`. Optional so
   * a test double that only sends does not need it; `createLineClient` always has it.
   */
  getMessageContent?(messageId: string, maxBytes: number): Promise<LineContentResult>;
}

/** What LINE returned for a message's content (a picture a customer sent). */
export type LineContentResult =
  | { ok: true; bytes: Buffer }
  /** `tooLarge`: more than `maxBytes` (nothing is kept). `definite`: LINE answered 4xx (gone or not ours). */
  | { ok: false; tooLarge?: boolean; definite: boolean; status?: number };

export interface LineClientOptions {
  channelAccessToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Where message content is fetched (a separate host from `baseUrl`). */
  dataBaseUrl?: string;
  timeoutMs?: number;
}

/** A small fetch wrapper over the Messaging API. The token only ever goes in a header. */
export function createLineClient(options: LineClientOptions): LineClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? 'https://api.line.me';
  const dataBase = options.dataBaseUrl ?? 'https://api-data.line.me';
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

  async function getContent(messageId: string, maxBytes: number): Promise<LineContentResult> {
    try {
      // The content lives on a different host from the Messaging API; the id is LINE's own digits.
      if (!/^\d{1,32}$/.test(messageId)) return { ok: false, definite: true };
      const response = await doFetch(`${dataBase}/v2/bot/message/${messageId}/content`, {
        headers: { authorization: `Bearer ${options.channelAccessToken}` },
        signal: AbortSignal.timeout(timeoutMs * 2),
      });
      if (!response.ok) {
        return {
          ok: false,
          definite: response.status >= 400 && response.status < 500,
          status: response.status,
        };
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true, definite: true };
      }
      // Read in pieces and stop at the cap: a missing or wrong length never fills the memory.
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, tooLarge: true, definite: true };
        }
        chunks.push(value);
      }
      return { ok: true, bytes: Buffer.concat(chunks) };
    } catch {
      return { ok: false, definite: false };
    }
  }

  return {
    getMessageContent: getContent,
    reply: (replyToken, messages) => post('/v2/bot/message/reply', { replyToken, messages }),
    push: (to, messages, retryKey) =>
      post(
        '/v2/bot/message/push',
        { to, messages },
        retryKey ? { 'x-line-retry-key': retryKey } : {},
      ),
  };
}
