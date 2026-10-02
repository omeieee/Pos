/**
 * Test fixtures. Everything here is made up: fake names, fake tokens, example.test addresses.
 * No real PIN, password, token or customer data belongs in a test (CLAUDE.md rule 10).
 */
import type { SessionResponse } from '@sds/shared';

export const IDS = {
  owner: '3f1c2a7e-8b4d-4e6a-9c1f-2d5b7a9e0c11',
  cashier: '7a9d4c20-5e1b-4f3a-8d6c-1b2e3f4a5c66',
  kitchen: '0b6e8d12-3c4f-4a57-9e8b-6d7c8e9f0a22',
  device: 'c4d5e6f7-1a2b-4c3d-8e4f-5a6b7c8d9e00',
  order: '9e8d7c6b-5a49-4837-a625-140312ffeedd',
  menuItem: '11111111-2222-4333-8444-555555555555',
} as const;

/** Looks like a real token to the format checks, but is not one. */
export const FAKE_SESSION_TOKEN = 'sds_ses_FAKEFAKEFAKEFAKEFAKEFAKE0001';
export const FAKE_DEVICE_TOKEN = 'sds_dev_FAKEFAKEFAKEFAKEFAKEFAKE0002';

export const FAKE_EMAIL = 'owner@example.test';

export function sessionBody(
  role: 'owner' | 'manager' | 'cashier' | 'kitchen' = 'cashier',
  overrides: Partial<SessionResponse> = {},
): SessionResponse {
  const permissionsByRole: Record<string, SessionResponse['permissions']> = {
    owner: ['order.create', 'order.accept', 'menu.edit', 'settings.edit', 'device.manage'],
    manager: ['order.create', 'order.accept', 'menu.edit', 'settings.edit'],
    cashier: ['order.create', 'order.accept', 'order.advance'],
    kitchen: ['order.accept', 'order.advance'],
  };
  return {
    sessionToken: FAKE_SESSION_TOKEN,
    expiresAt: '2030-01-01T12:00:00.000Z',
    idleTimeoutSeconds: 7200,
    staff: {
      id: role === 'owner' ? IDS.owner : IDS.cashier,
      displayName: role === 'owner' ? 'คุณตัวอย่าง' : 'พนักงานตัวอย่าง',
      role,
    },
    permissions: permissionsByRole[role] ?? [],
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: unknown;
  /** The bytes of a binary body (a photo upload), else undefined. */
  bytes?: Uint8Array;
}

export type Reply = { status: number; json?: unknown; text?: string };

/** The JSON body of a recorded call; fails the test if the call never happened. */
export function bodyOf<T = Record<string, unknown>>(call: RecordedCall | undefined): T {
  if (!call) throw new Error('no call was recorded');
  return call.body as T;
}

/** A fetch double: records every call and answers with whatever the test returns. */
export function mockFetch(responder: (call: RecordedCall) => Reply | Promise<Reply>) {
  const calls: RecordedCall[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const binary = init?.body instanceof Blob ? init.body : undefined;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: raw === undefined ? undefined : JSON.parse(raw),
      ...(binary ? { bytes: new Uint8Array(await binary.arrayBuffer()) } : {}),
    };
    calls.push(call);
    const reply = await responder(call);
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(reply.status === 204 ? null : text, { status: reply.status });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

export const apiError = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): Reply => ({
  status,
  json: { code, message: 'English developer text that must never reach the screen', details },
});
