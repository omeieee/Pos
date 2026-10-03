import { describe, expect, test } from 'vitest';
import { createLiffVerifier, LiffUnavailableError, liffChannelId } from './liff-verify.ts';

// Made-up ids: not the shop's real channel.
const CHANNEL = '1234567890';
const NOW = new Date('2026-10-04T05:00:00Z');
const USER = 'Utest00000000000000000000000000c3';
const TOKEN = 't'.repeat(40);

interface Call {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

function fake(responses: Array<{ status: number; body?: unknown } | 'network-error'>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      auth: new Headers(init?.headers).get('authorization'),
    });
    const next = queue.shift();
    if (next === undefined || next === 'network-error') throw new TypeError('network');
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as typeof fetch;
  return {
    calls,
    verifier: createLiffVerifier({ channelId: CHANNEL, fetch: fetcher, now: () => NOW }),
  };
}

const idToken = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    iss: 'https://access.line.me',
    sub: USER,
    aud: CHANNEL,
    exp: Math.floor(NOW.getTime() / 1000) + 3000,
    ...over,
  },
});

describe('liffChannelId', () => {
  test('is the numeric prefix of the LIFF id, never the messaging channel', () => {
    expect(liffChannelId('1234567890-abcdefgh')).toBe('1234567890');
    expect(liffChannelId(undefined)).toBeUndefined();
    expect(liffChannelId('abcdefgh')).toBeUndefined();
    expect(liffChannelId('12-abc')).toBeUndefined();
    expect(liffChannelId('1234567890-')).toBeUndefined();
  });
});

describe('ID token', () => {
  test('a genuine token gives the user id, and LINE is asked about OUR channel', async () => {
    const { verifier, calls } = fake([idToken()]);
    expect(await verifier.verify({ idToken: TOKEN })).toEqual({ userId: USER });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.line.me/oauth2/v2.1/verify');
    expect(calls[0]?.method).toBe('POST');
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get('client_id')).toBe(CHANNEL);
    expect(form.get('id_token')).toBe(TOKEN);
  });

  test('a token for another channel, an expired one or another issuer is refused', async () => {
    expect(
      await fake([idToken({ aud: '999999999' })]).verifier.verify({ idToken: TOKEN }),
    ).toBeNull();
    expect(
      await fake([idToken({ exp: Math.floor(NOW.getTime() / 1000) - 1 })]).verifier.verify({
        idToken: TOKEN,
      }),
    ).toBeNull();
    expect(
      await fake([idToken({ iss: 'https://evil.example' })]).verifier.verify({ idToken: TOKEN }),
    ).toBeNull();
  });

  test('LINE saying the token is bad is null; LINE being down is an error, not a refusal', async () => {
    expect(await fake([{ status: 400 }]).verifier.verify({ idToken: TOKEN })).toBeNull();
    await expect(
      fake([{ status: 500 }]).verifier.verify({ idToken: TOKEN }),
    ).rejects.toBeInstanceOf(LiffUnavailableError);
    await expect(
      fake([{ status: 429 }]).verifier.verify({ idToken: TOKEN }),
    ).rejects.toBeInstanceOf(LiffUnavailableError);
    await expect(
      fake(['network-error']).verifier.verify({ idToken: TOKEN }),
    ).rejects.toBeInstanceOf(LiffUnavailableError);
  });

  test('an answer without a subject is not trusted', async () => {
    expect(
      await fake([{ status: 200, body: { aud: CHANNEL, exp: 9999999999 } }]).verifier.verify({
        idToken: TOKEN,
      }),
    ).toBeNull();
  });
});

describe('access token', () => {
  const verified = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: { client_id: CHANNEL, expires_in: 1000, scope: 'profile', ...over },
  });
  const profile = { status: 200, body: { userId: USER, displayName: 'must never be read' } };

  test('verifies it for our channel, then reads the user id from the profile', async () => {
    const { verifier, calls } = fake([verified(), profile]);
    expect(await verifier.verify({ accessToken: TOKEN })).toEqual({ userId: USER });
    expect(calls[0]?.url).toContain('/oauth2/v2.1/verify?access_token=');
    expect(calls[1]?.url).toBe('https://api.line.me/v2/profile');
    expect(calls[1]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test('a token issued to another channel never reaches the profile call', async () => {
    const { verifier, calls } = fake([verified({ client_id: '999999999' }), profile]);
    expect(await verifier.verify({ accessToken: TOKEN })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('an expired or rejected token is null', async () => {
    expect(
      await fake([verified({ expires_in: 0 }), profile]).verifier.verify({ accessToken: TOKEN }),
    ).toBeNull();
    expect(await fake([{ status: 400 }]).verifier.verify({ accessToken: TOKEN })).toBeNull();
    expect(
      await fake([verified(), { status: 401 }]).verifier.verify({ accessToken: TOKEN }),
    ).toBeNull();
  });
});
