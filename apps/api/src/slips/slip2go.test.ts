/**
 * The Slip2Go client (D-27) against a FAKE fetch with synthetic bodies. The real service is never
 * called. The key is a made-up marker, so a test can prove it never reaches a log line.
 */
import { describe, expect, test } from 'vitest';
import { createSlip2goVerifier, type SlipVerifier } from './slip2go.ts';

const KEY = 'TEST-ONLY-KEY-MARKER-9f3a';
const BASE = 'https://slip2go.example.test';
const QR = '00410006000001010300000000000SYNTHETIC-QR-TEXT-NOT-A-REAL-SLIP';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}

type Reply = { status: number; body?: unknown; raw?: string } | Error | 'hang';

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | FormData | undefined,
    });
    const reply = replies.shift() ?? new Error('no more replies');
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    if (reply instanceof Error) throw reply;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;
  return { impl, calls };
}

const logs: Record<string, unknown>[] = [];
const make = (replies: Reply[], timeoutMs = 1000): { v: SlipVerifier; calls: Call[] } => {
  logs.length = 0;
  const { impl, calls } = fakeFetch(replies);
  const v = createSlip2goVerifier(
    {
      baseUrl: BASE,
      secretKey: KEY,
      timeoutMs,
      log: { info: (o) => logs.push(o), warn: (o) => logs.push(o) },
    },
    impl,
  );
  return { v, calls };
};

const conditions = {
  amountSatang: 1500,
  receivers: [{ accountType: '02001', accountNumber: '0899994321' }],
  notBefore: new Date('2026-10-12T03:00:00.000Z'),
};

const valid = {
  code: '200200',
  message: 'Slip is valid',
  data: {
    referenceId: 'REF-1',
    transRef: '0'.repeat(25),
    amount: 15,
    dateTime: '2026-10-12T10:30:00+07:00',
    sender: { bank: { id: '002' }, account: { name: 'PRIVATE NAME' } },
  },
};

describe('verifyQr', () => {
  test('posts the QR text and the conditions, with the Bearer key', async () => {
    const { v, calls } = make([{ status: 200, body: valid }]);
    const result = await v.verifyQr(QR, conditions);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/api/verify-slip/qr-code/info`);
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers['content-type']).toContain('application/json');
    expect(JSON.parse(String(call?.body))).toEqual({
      payload: {
        qrCode: QR,
        checkCondition: {
          checkAmount: { type: 'eq', amount: '15.00' },
          checkReceiver: [{ accountType: '02001', accountNumber: '0899994321' }],
          checkDate: { type: 'gte', date: '2026-10-12T03:00:00.000Z' },
        },
      },
    });
    expect(result).toEqual({
      kind: 'answer',
      code: '200200',
      referenceId: 'REF-1',
      transRef: '0'.repeat(25),
      senderBank: '002',
      amountSatang: 1500,
      dateTime: '2026-10-12T10:30:00+07:00',
    });
  });

  test('branches on the code, not the HTTP status', async () => {
    const wrong = make([{ status: 200, body: { code: '200402', message: 'Amount mismatch' } }]);
    expect(await wrong.v.verifyQr(QR, conditions)).toMatchObject({
      kind: 'answer',
      code: '200402',
    });
    const bad = make([{ status: 400, body: { code: '400400', message: 'bad' } }]);
    expect(await bad.v.verifyQr(QR, conditions)).toMatchObject({ kind: 'answer', code: '400400' });
    const blocked = make([{ status: 401, body: { code: '401004', message: 'expired' } }]);
    expect(await blocked.v.verifyQr(QR, conditions)).toMatchObject({
      kind: 'answer',
      code: '401004',
    });
  });

  test('an amount that is not a clean baht figure comes back as null', async () => {
    const odd = { ...valid, data: { ...valid.data, amount: 0.1 + 0.2 } };
    const { v } = make([{ status: 200, body: odd }]);
    expect(await v.verifyQr(QR, conditions)).toMatchObject({ code: '200200', amountSatang: null });
  });

  test('a network error, a timeout, 429 and 5xx are transient and never throw', async () => {
    const down = make([new Error(`connect failed ${BASE} ${KEY}`)]);
    expect(await down.v.verifyQr(QR, conditions)).toEqual({ kind: 'transient' });
    const slow = make(['hang'], 20);
    expect(await slow.v.verifyQr(QR, conditions)).toEqual({ kind: 'transient' });
    const limited = make([{ status: 429, raw: 'slow down' }]);
    expect(await limited.v.verifyQr(QR, conditions)).toEqual({ kind: 'transient' });
    const broken = make([{ status: 502, raw: '<html>bad gateway</html>' }]);
    expect(await broken.v.verifyQr(QR, conditions)).toEqual({ kind: 'transient' });
  });

  test('a body that is not the expected shape is an answer the checker will not trust', async () => {
    const junk = make([{ status: 200, raw: 'not json' }]);
    expect(await junk.v.verifyQr(QR, conditions)).toMatchObject({
      kind: 'answer',
      code: 'invalid_response',
    });
    const noCode = make([{ status: 200, body: { hello: 1 } }]);
    expect(await noCode.v.verifyQr(QR, conditions)).toMatchObject({ code: 'invalid_response' });
  });
});

describe('verifyImage', () => {
  test('sends the file and the conditions at the root of the payload; 201 is fine', async () => {
    const { v, calls } = make([{ status: 201, body: valid }]);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const result = await v.verifyImage(bytes, 'image/png', conditions);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/api/verify-slip/qr-image/info`);
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    const form = call?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('file') as File;
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('slip.png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    expect(JSON.parse(String(form.get('payload')))).toEqual({
      checkAmount: { type: 'eq', amount: '15.00' },
      checkReceiver: [{ accountType: '02001', accountNumber: '0899994321' }],
      checkDate: { type: 'gte', date: '2026-10-12T03:00:00.000Z' },
    });
    expect(result).toMatchObject({ kind: 'answer', code: '200200', amountSatang: 1500 });
  });
});

describe('accountInfo', () => {
  test('reads the quota and the expiry, and is a GET', async () => {
    const { v, calls } = make([
      {
        status: 200,
        body: {
          code: '200001',
          message: 'ok',
          data: {
            estimatedQuotaSlip: 12,
            packageExpiredDate: '2026-10-19T23:59:59.999Z',
            shop: 'x',
          },
        },
      },
    ]);
    expect(await v.accountInfo()).toEqual({
      kind: 'info',
      estimatedQuotaSlip: 12,
      packageExpiredDate: '2026-10-19T23:59:59.999Z',
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/account/info`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test('a failure is reported without a throw', async () => {
    const { v } = make([{ status: 401, body: { code: '401001', message: 'bad key' } }]);
    expect(await v.accountInfo()).toEqual({ kind: 'failed', code: '401001' });
    const down = make([new Error('x')]);
    expect(await down.v.accountInfo()).toEqual({ kind: 'failed' });
  });
});

describe('what the logs may hold', () => {
  test('the code and the milliseconds only: never the key, the QR text, a URL or a body', async () => {
    const calls: Reply[] = [
      { status: 200, body: valid },
      new Error(`boom ${KEY} ${QR}`),
      { status: 200, body: { code: '200402', message: 'PRIVATE NAME mismatch' } },
    ];
    const { v } = make(calls);
    await v.verifyQr(QR, conditions);
    await v.verifyQr(QR, conditions);
    await v.verifyQr(QR, conditions);
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    for (const secret of [KEY, QR, BASE, 'PRIVATE NAME', '0899994321', 'REF-1', 'qr-code']) {
      expect(text).not.toContain(secret);
    }
    expect(logs[0]).toMatchObject({ code: '200200' });
    expect(typeof logs[0]?.ms).toBe('number');
  });
});
