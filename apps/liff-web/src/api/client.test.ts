import { describe, expect, test } from 'vitest';
import { ApiFailure, createApi } from './client.ts';

interface Call {
  url: string;
  method: string;
  auth: string | null;
  type: string | null;
  body: string;
}

function server(handler: (call: Call, n: number) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      type: new Headers(init?.headers).get('content-type'),
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    const { status, body } = handler(call, calls.length);
    return new Response(JSON.stringify(body ?? {}), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

const session = (token: string) => ({
  status: 200,
  body: { token, expiresAt: 'x', privacyAcknowledged: true, privacyVersion: 'v' },
});

describe('the customer API client', () => {
  test('signs in with the LIFF credential once, then sends the session token', async () => {
    const { calls, fetcher } = server((call) =>
      call.url.endsWith('/session') ? session('tok-1') : { status: 200, body: { orders: [] } },
    );
    const api = createApi({
      baseUrl: 'https://api.example.test/',
      credential: () => ({ idToken: 'liff-id-token' }),
      fetch: fetcher,
    });
    await api.orders();
    await api.orders();
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.test/v1/app/session',
      'https://api.example.test/v1/app/orders',
      'https://api.example.test/v1/app/orders',
    ]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ idToken: 'liff-id-token' });
    expect(calls[1]?.auth).toBe('Bearer tok-1');
    expect(calls[2]?.auth).toBe('Bearer tok-1');
  });

  test('a 401 gets one fresh sign-in and one retry, not a loop', async () => {
    let tokens = 0;
    const { calls, fetcher } = server((call) => {
      if (call.url.endsWith('/session')) return session(`tok-${++tokens}`);
      return call.auth === 'Bearer tok-2'
        ? { status: 200, body: { orders: [] } }
        : { status: 401, body: { code: 'UNAUTHENTICATED' } };
    });
    const api = createApi({
      baseUrl: 'https://a.test',
      credential: () => ({ idToken: 'x' }),
      fetch: fetcher,
    });
    await expect(api.orders()).resolves.toEqual({ orders: [] });
    expect(calls.filter((c) => c.url.endsWith('/session'))).toHaveLength(2);

    const always401 = server((call) =>
      call.url.endsWith('/session')
        ? session('t')
        : { status: 401, body: { code: 'UNAUTHENTICATED' } },
    );
    const stubborn = createApi({
      baseUrl: 'https://a.test',
      credential: () => ({ idToken: 'x' }),
      fetch: always401.fetcher,
    });
    await expect(stubborn.orders()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(always401.calls).toHaveLength(4); // sign in, call, sign in, call
  });

  test('errors carry the API code; a dead network is NETWORK; no credential is NO_CREDENTIAL', async () => {
    const { fetcher } = server((call) =>
      call.url.endsWith('/session')
        ? session('t')
        : { status: 409, body: { code: 'SHOP_CLOSED', message: 'x' } },
    );
    const api = createApi({
      baseUrl: 'https://a.test',
      credential: () => ({ idToken: 'x' }),
      fetch: fetcher,
    });
    const error = await api.checkout().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ status: 409, code: 'SHOP_CLOSED' });

    const offline = createApi({
      baseUrl: 'https://a.test',
      credential: () => ({ idToken: 'x' }),
      fetch: (async () => {
        throw new TypeError('offline');
      }) as typeof fetch,
    });
    await expect(offline.menu()).rejects.toMatchObject({ code: 'NETWORK' });

    const anonymous = createApi({
      baseUrl: 'https://a.test',
      credential: () => null,
      fetch: fetcher,
    });
    await expect(anonymous.orders()).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
  });

  test('the menu is the public LINE menu; placing an order sends no price and no user id', async () => {
    const { calls, fetcher } = server((call) =>
      call.url.endsWith('/session') ? session('t') : { status: 200, body: {} },
    );
    const api = createApi({
      baseUrl: 'https://a.test',
      credential: () => ({ idToken: 'x' }),
      fetch: fetcher,
    });
    await api.menu();
    expect(calls[0]?.url).toBe('https://a.test/v1/menu?channel=line');
    expect(calls[0]?.auth).toBeNull();
    await api.claim('order-1');
    expect(calls.at(-1)).toMatchObject({
      url: 'https://a.test/v1/app/orders/order-1/claim',
      method: 'POST',
    });
    await api.selectPayment('order-1', 'cash');
    const body = JSON.parse(calls.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientRequestId', 'method']);
  });

  test('sends a slip as the raw picture with its own content type', async () => {
    const { calls, fetcher } = server((call) =>
      call.url.endsWith('/session') ? session('tok-1') : { status: 200, body: { id: 'o' } },
    );
    const api = createApi({
      baseUrl: 'https://api.example.test',
      credential: () => ({ idToken: 'liff-id-token' }),
      fetch: fetcher,
    });
    await api.attachSlip('order-1', new Blob(['x'], { type: 'image/png' }));
    const slip = calls[calls.length - 1];
    expect(slip?.url).toBe('https://api.example.test/v1/app/orders/order-1/slip');
    expect(slip?.method).toBe('POST');
    expect(slip?.type).toBe('image/png');
    expect(slip?.auth).toBe('Bearer tok-1');
  });
});
