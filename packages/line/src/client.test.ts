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

  test('a 409 on a retry key means LINE already accepted that push', async () => {
    expect(await client(() => new Response('', { status: 409 })).c.push('U', MSGS, 'k')).toEqual({
      ok: true,
    });
  });
});
