import { describe, expect, test, vi } from 'vitest';
import { createLineClient } from './client.ts';

const MSGS = [{ type: 'text' as const, text: 'hi' }];

function client(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond());
  return {
    fetchMock,
    c: createLineClient({
      channelAccessToken: 'fake-token',
      fetch: fetchMock as unknown as typeof fetch,
      baseUrl: 'https://line.example.test',
    }),
  };
}

describe('createLineClient', () => {
  test('reply posts the token in the header and the body shape LINE expects', async () => {
    const { c, fetchMock } = client(() => new Response('{}', { status: 200 }));
    expect(await c.reply('rt', MSGS)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://line.example.test/v2/bot/message/reply');
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Bearer fake-token',
    );
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      replyToken: 'rt',
      messages: MSGS,
    });
  });

  test('push sends the retry key header', async () => {
    const { c, fetchMock } = client(() => new Response('{}', { status: 200 }));
    await c.push('U1', MSGS, 'key-1');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(((init as RequestInit).headers as Record<string, string>)['x-line-retry-key']).toBe(
      'key-1',
    );
  });

  test('4xx is a definite failure, 5xx and network errors are not', async () => {
    expect(await client(() => new Response('', { status: 400 })).c.push('U', MSGS)).toEqual({
      ok: false,
      definite: true,
      status: 400,
    });
    expect(await client(() => new Response('', { status: 500 })).c.push('U', MSGS)).toEqual({
      ok: false,
      definite: false,
      status: 500,
    });
    const boom = client(() => Promise.reject(new Error('network')));
    expect(await boom.c.push('U', MSGS)).toEqual({ ok: false, definite: false });
  });

  test("a 429 for the month's message limit is capped; a rate-limit 429 is a plain refusal", async () => {
    const answer = (body: string) => () => new Response(body, { status: 429 });
    // LINE's documented body when the plan's monthly messages are used up.
    expect(
      await client(answer('{"message":"You have reached your monthly limit."}')).c.push('U', MSGS),
    ).toEqual({ ok: false, definite: true, status: 429, capped: true });
    // Too many calls a second: nothing was sent, but the month is not over.
    expect(
      await client(
        answer('{"message":"The API rate limit has been exceeded. Try again later."}'),
      ).c.push('U', MSGS),
    ).toEqual({ ok: false, definite: true, status: 429 });
    // A 429 whose body cannot be read: a shop this size never meets the rate limit, so it is the month.
    expect(await client(answer('not json')).c.push('U', MSGS)).toEqual({
      ok: false,
      definite: true,
      status: 429,
      capped: true,
    });
    // A reply is free and never capped, whatever LINE answers.
    expect(
      await client(answer('{"message":"You have reached your monthly limit."}')).c.reply(
        'rt',
        MSGS,
      ),
    ).toEqual({ ok: false, definite: true, status: 429 });
  });

  test('a 409 on a retry key means LINE already accepted that push', async () => {
    expect(await client(() => new Response('', { status: 409 })).c.push('U', MSGS, 'k')).toEqual({
      ok: true,
    });
  });
  describe('getMessageContent', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const dataClient = (respond: () => Response) => {
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond());
      return {
        fetchMock,
        c: createLineClient({
          channelAccessToken: 'fake-token',
          fetch: fetchMock as unknown as typeof fetch,
          dataBaseUrl: 'https://data.example.test',
        }),
      };
    };

    test('fetches from the data host with the token in the header and returns the bytes', async () => {
      const { c, fetchMock } = dataClient(() => new Response(bytes, { status: 200 }));
      const result = await c.getMessageContent?.('123456', 1000);
      expect(result).toEqual({ ok: true, bytes: Buffer.from(bytes) });
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://data.example.test/v2/bot/message/123456/content');
      expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe(
        'Bearer fake-token',
      );
    });

    test('stops at the cap, by the declared length or by what actually arrives', async () => {
      const declared = dataClient(
        () => new Response(bytes, { status: 200, headers: { 'content-length': '5000' } }),
      );
      expect(await declared.c.getMessageContent?.('1', 100)).toEqual({
        ok: false,
        tooLarge: true,
        definite: true,
      });
      const undeclared = dataClient(() => new Response(new Uint8Array(500), { status: 200 }));
      expect(await undeclared.c.getMessageContent?.('1', 100)).toEqual({
        ok: false,
        tooLarge: true,
        definite: true,
      });
    });

    test('4xx is definite, 5xx and network errors are not, and a message id that is not digits is never sent', async () => {
      expect(
        await dataClient(() => new Response('', { status: 404 })).c.getMessageContent?.('1', 100),
      ).toEqual({ ok: false, definite: true, status: 404 });
      expect(
        await dataClient(() => new Response('', { status: 503 })).c.getMessageContent?.('1', 100),
      ).toEqual({ ok: false, definite: false, status: 503 });
      const bad = dataClient(() => new Response(bytes));
      expect(await bad.c.getMessageContent?.('../x', 100)).toEqual({ ok: false, definite: true });
      expect(bad.fetchMock).not.toHaveBeenCalled();
    });
  });
});
