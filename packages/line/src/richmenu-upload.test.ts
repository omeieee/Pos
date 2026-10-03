import { describe, expect, test } from 'vitest';
import { loadRichMenu } from './richmenu.ts';
import { RichMenuUploadError, uploadRichMenu } from './richmenu-upload.ts';

const TOKEN = 'fake-token-for-tests-only';
const menu = loadRichMenu(
  {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'test',
    chatBarText: 'สั่งอาหาร',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: 'uri', uri: '{{LIFF_BASE_URL}}/menu' },
      },
    ],
  },
  { liffUrl: 'https://liff.line.me/1-a' },
);

function fake(statuses: number[]) {
  const calls: { url: string; method: string; auth: string | null; type: string | null }[] = [];
  const queue = [...statuses];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      type: headers.get('content-type'),
    });
    const status = queue.shift() ?? 200;
    return new Response(JSON.stringify({ richMenuId: 'richmenu-1' }), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('uploadRichMenu', () => {
  test('creates, uploads the picture, then sets the default, in that order', async () => {
    const { calls, fetcher } = fake([200, 200, 200]);
    const id = await uploadRichMenu({
      channelAccessToken: TOKEN,
      menu,
      image: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      fetch: fetcher,
    });
    expect(id).toBe('richmenu-1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.line.me/v2/bot/richmenu',
      'POST https://api-data.line.me/v2/bot/richmenu/richmenu-1/content',
      'POST https://api.line.me/v2/bot/user/all/richmenu/richmenu-1',
    ]);
    expect(calls[1]?.type).toBe('image/png');
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test('stops at the first failing step and names it, without the token', async () => {
    const { calls, fetcher } = fake([200, 400]);
    const error = await uploadRichMenu({
      channelAccessToken: TOKEN,
      menu,
      image: new Uint8Array([1]),
      contentType: 'image/png',
      fetch: fetcher,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RichMenuUploadError);
    expect(error).toMatchObject({ step: 'image', status: 400 });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(calls).toHaveLength(2); // never set as default without a picture
  });
});
