/**
 * A fake of the /v1/auth API that behaves like apps/api, for tests and for `pnpm dev` when there
 * is no local API (the deployed API is never called from the dev server or from tests).
 *
 * Everything in here is made up: fake staff, fake PINs, an example.test address, fake codes. Do
 * not copy a real value into it. It is only reachable through `src/dev/enable.ts`, which is
 * guarded by `import.meta.env.DEV`, so production builds do not contain it.
 *
 * Sign in as (dev):
 * - owner:  owner@example.test / example-password / app codes 111111, 222222, 333333, 444444,
 *           555555 (each works once, like the real server's replay protection) or the recovery
 *           code AAAA-BBBB-CCCC-DDDD. Owner PIN 654321.
 * - manager PIN 123456 · cashier PIN 1234 · kitchen PIN 4321.
 *
 * Sessions and device tokens are self-describing (not looked up), so a page reload does not log
 * the dev server out of a device it registered. Failure counters, used codes and step-up are
 * kept in memory.
 */
import {
  authMeResponseSchema,
  ownerLoginInputSchema,
  ownerStepUpInputSchema,
  type Permission,
  pinLoginInputSchema,
  ROLE_PERMISSIONS,
  registerDeviceInputSchema,
  staffStepUpInputSchema,
} from '@sds/shared';
import { createMockShop } from './mock-shop.ts';

type Role = 'owner' | 'manager' | 'cashier' | 'kitchen';

export interface MockStaff {
  id: string;
  displayName: string;
  role: Role;
  pin: string;
}

export const MOCK_STAFF: readonly MockStaff[] = [
  {
    id: '3f1c2a7e-8b4d-4e6a-9c1f-2d5b7a9e0c11',
    displayName: 'คุณตัวอย่าง',
    role: 'owner',
    pin: '654321',
  },
  {
    id: '5b2d9e41-7c3a-4f68-8a1d-9e0f1a2b3c44',
    displayName: 'ผู้จัดการตัวอย่าง',
    role: 'manager',
    pin: '123456',
  },
  {
    id: '7a9d4c20-5e1b-4f3a-8d6c-1b2e3f4a5c66',
    displayName: 'พนักงานตัวอย่าง',
    role: 'cashier',
    pin: '1234',
  },
  {
    id: '0b6e8d12-3c4f-4a57-9e8b-6d7c8e9f0a22',
    displayName: 'ครัวตัวอย่าง',
    role: 'kitchen',
    pin: '4321',
  },
];

export const MOCK_OWNER = {
  email: 'owner@example.test',
  password: 'example-password',
  recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
  totpCodes: ['111111', '222222', '333333', '444444', '555555'],
} as const;

/** The same table the real API uses, so the dev app shows exactly what each role may do. */
const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [...ROLE_PERMISSIONS.owner],
  manager: [...ROLE_PERMISSIONS.manager],
  cashier: [...ROLE_PERMISSIONS.cashier],
  kitchen: [...ROLE_PERMISSIONS.kitchen],
};

export interface MockServerOptions {
  now?: () => number;
  /** Lock length after 5 wrong PINs, in seconds (the real server escalates 5 min, 1 h, 24 h). */
  pinLockSeconds?: number;
  /** Artificial latency per call, for the dev server. */
  delayMs?: number;
  /** Answer before the routes do; return a Response to inject a fault. */
  intercept?: (call: { method: string; path: string; body: unknown }) => Response | undefined;
}

interface SessionClaims {
  staffId: string;
  kind: 'pin' | 'owner';
  deviceToken: string | null;
  /** Issue counter, so "revoke every session" can cut at a point in time. */
  n: number;
}

/** base64url of the UTF-8 JSON, so Thai device names survive `btoa`. */
const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const decode = <T>(token: string, prefix: string): T | null => {
  if (!token.startsWith(prefix)) return null;
  try {
    const binary = atob(token.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};

const SESSION_PREFIX = 'sds_ses_MOCK';
const DEVICE_PREFIX = 'sds_dev_MOCK';
const MAX_PIN_FAILURES = 5;

export function createMockServer(options: MockServerOptions = {}) {
  const now = options.now ?? Date.now;
  const lockSeconds = options.pinLockSeconds ?? 300;
  const revoked = new Set<string>();
  const usedCodes = new Set<string>();
  const stepUps = new Map<string, number>();
  const pinFailures = new Map<string, { count: number; lockedUntil: number }>();
  let ownerFailures = 0;
  let counter = 0;
  /** Sessions issued at or before this counter value are treated as ended. */
  let revokedUpTo = 0;
  const calls: { method: string; path: string }[] = [];
  // The menu, orders, sync and the socket: see mock-shop.ts.
  const shop = createMockShop({ now });

  const reply = (status: number, body?: unknown): Response =>
    new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fail = (status: number, code: string, details: Record<string, unknown> = {}) =>
    reply(status, { code, message: 'mock server error', details });

  const deviceOf = (token: string | undefined) => {
    if (!token || revoked.has(token)) return null;
    return decode<{ id: string; name: string; kind: string }>(token, DEVICE_PREFIX);
  };
  const sessionOf = (header: string | undefined, deviceToken: string | undefined) => {
    const token = /^Bearer (.+)$/i.exec(header ?? '')?.[1];
    if (!token || revoked.has(token)) return null;
    const claims = decode<SessionClaims>(token, SESSION_PREFIX);
    if (!claims || claims.n <= revokedUpTo) return null;
    // Removing a device ends the sessions opened on it.
    if (claims.deviceToken && revoked.has(claims.deviceToken)) return null;
    // A PIN session only works with the device token it was opened on.
    if (claims.kind === 'pin' && claims.deviceToken !== (deviceToken ?? null)) return 'mismatch';
    const staff = MOCK_STAFF.find((s) => s.id === claims.staffId);
    return staff ? { token, staff, claims } : null;
  };
  const mintSession = (staff: MockStaff, kind: 'pin' | 'owner', deviceToken: string | null) => {
    counter += 1;
    return `${SESSION_PREFIX}${encode({ staffId: staff.id, kind, deviceToken, n: counter })}`;
  };
  const sessionBody = (staff: MockStaff, kind: 'pin' | 'owner', deviceToken: string | null) => ({
    sessionToken: mintSession(staff, kind, deviceToken),
    expiresAt: new Date(now() + (kind === 'pin' ? 12 : 8) * 3600_000).toISOString(),
    idleTimeoutSeconds: kind === 'pin' ? 7200 : 1800,
    staff: { id: staff.id, displayName: staff.displayName, role: staff.role },
    permissions: PERMISSIONS[staff.role],
  });

  /** The owner's factors: password, then an unused app code or the recovery code. */
  const ownerFactorsOk = (password: string, totp?: string, recoveryCode?: string): boolean => {
    if (password !== MOCK_OWNER.password) return false;
    if (totp !== undefined) {
      const valid: readonly string[] = MOCK_OWNER.totpCodes;
      if (!valid.includes(totp) || usedCodes.has(totp)) return false;
      usedCodes.add(totp);
      return true;
    }
    if (recoveryCode === undefined) return false;
    const normal = recoveryCode.replace(/[ -]/g, '').toUpperCase();
    if (normal !== MOCK_OWNER.recoveryCode.replace(/-/g, '') || usedCodes.has('recovery'))
      return false;
    usedCodes.add('recovery');
    return true;
  };

  const checkPin = (staff: MockStaff | undefined, pin: string): Response | 'ok' => {
    if (!staff) return fail(401, 'INVALID_CREDENTIALS');
    const entry = pinFailures.get(staff.id) ?? { count: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now()) {
      return fail(423, 'ACCOUNT_LOCKED', {
        retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now()) / 1000)),
      });
    }
    if (staff.pin === pin) {
      pinFailures.delete(staff.id);
      return 'ok';
    }
    const count = (entry.lockedUntil ? 0 : entry.count) + 1;
    if (count >= MAX_PIN_FAILURES) {
      pinFailures.set(staff.id, { count, lockedUntil: now() + lockSeconds * 1000 });
      return fail(423, 'ACCOUNT_LOCKED', { retryAfterSeconds: lockSeconds });
    }
    pinFailures.set(staff.id, { count, lockedUntil: 0 });
    return fail(401, 'INVALID_CREDENTIALS');
  };

  const validation = () => fail(400, 'VALIDATION_ERROR');

  function route(
    method: string,
    path: string,
    headers: Headers,
    body: unknown,
    query: URLSearchParams,
  ): Response {
    const deviceHeader = headers.get('x-device-token') ?? undefined;
    const auth = headers.get('authorization') ?? undefined;

    // The public menu needs no session.
    if (method === 'GET' && path === '/v1/menu') {
      const answer = shop.handle(method, path, query, body);
      if (answer) return reply(answer.status, answer.body);
    }

    if (method === 'GET' && path === '/v1/auth/staff') {
      if (!deviceOf(deviceHeader)) return fail(401, 'DEVICE_UNREGISTERED');
      return reply(200, {
        staff: MOCK_STAFF.map(({ id, displayName, role }) => ({ id, displayName, role })),
      });
    }

    if (method === 'POST' && path === '/v1/auth/pin') {
      if (!deviceOf(deviceHeader)) return fail(401, 'DEVICE_UNREGISTERED');
      const input = pinLoginInputSchema.safeParse(body);
      if (!input.success) return validation();
      const staff = MOCK_STAFF.find((s) => s.id === input.data.staffId);
      const verdict = checkPin(staff, input.data.pin);
      if (verdict !== 'ok' || !staff)
        return verdict === 'ok' ? fail(401, 'INVALID_CREDENTIALS') : verdict;
      return reply(200, sessionBody(staff, 'pin', deviceHeader ?? null));
    }

    if (method === 'POST' && path === '/v1/auth/owner') {
      // A token that is sent but unknown blocks sign-in, as on the real API.
      if (deviceHeader !== undefined && !deviceOf(deviceHeader))
        return fail(401, 'DEVICE_UNREGISTERED');
      const input = ownerLoginInputSchema.safeParse(body);
      if (!input.success) return validation();
      const owner = MOCK_STAFF.find((s) => s.role === 'owner');
      const ok =
        owner !== undefined &&
        input.data.email === MOCK_OWNER.email &&
        ownerFactorsOk(input.data.password, input.data.totp, input.data.recoveryCode);
      // Like the real API, a locked owner answers the same as a wrong detail.
      if (!ok || !owner || ownerFailures >= MAX_PIN_FAILURES) {
        ownerFailures += 1;
        return fail(401, 'INVALID_CREDENTIALS');
      }
      ownerFailures = 0;
      return reply(200, sessionBody(owner, 'owner', deviceHeader ?? null));
    }

    if (method === 'POST' && path === '/v1/auth/logout') {
      const session = sessionOf(auth, deviceHeader);
      if (!session || session === 'mismatch') return fail(401, 'UNAUTHENTICATED');
      revoked.add(session.token);
      return reply(204);
    }

    // Everything below needs a live session.
    const session = sessionOf(auth, deviceHeader);
    if (session === 'mismatch') return fail(401, 'DEVICE_MISMATCH');
    if (!session) return fail(401, 'UNAUTHENTICATED');

    if (method === 'GET' && path === '/v1/auth/me') {
      const until = stepUps.get(session.token);
      return reply(
        200,
        authMeResponseSchema.parse({
          staff: {
            id: session.staff.id,
            displayName: session.staff.displayName,
            role: session.staff.role,
          },
          deviceId: deviceOf(deviceHeader)?.id ?? null,
          permissions: PERMISSIONS[session.staff.role],
          expiresAt: new Date(now() + 8 * 3600_000).toISOString(),
          stepUpUntil: until && until > now() ? new Date(until).toISOString() : null,
        }),
      );
    }

    if (method === 'POST' && path === '/v1/auth/step-up') {
      let ok = false;
      if (session.staff.role === 'owner') {
        const input = ownerStepUpInputSchema.safeParse(body);
        if (!input.success) return validation();
        ok = ownerFactorsOk(input.data.password, input.data.totp, input.data.recoveryCode);
      } else {
        const input = staffStepUpInputSchema.safeParse(body);
        if (!input.success) return validation();
        const verdict = checkPin(session.staff, input.data.pin);
        if (verdict !== 'ok') return verdict;
        ok = true;
      }
      if (!ok) return fail(401, 'INVALID_CREDENTIALS');
      const until = now() + 5 * 60_000;
      stepUps.set(session.token, until);
      return reply(200, { stepUpUntil: new Date(until).toISOString() });
    }

    if (method === 'POST' && path === '/v1/auth/device') {
      if (!PERMISSIONS[session.staff.role].includes('device.manage')) return fail(403, 'FORBIDDEN');
      if ((stepUps.get(session.token) ?? 0) <= now()) return fail(403, 'STEP_UP_REQUIRED');
      const input = registerDeviceInputSchema.safeParse(body);
      if (!input.success) return validation();
      counter += 1;
      const device = { id: crypto.randomUUID(), name: input.data.name, kind: input.data.kind };
      return reply(201, {
        device,
        deviceToken: `${DEVICE_PREFIX}${encode({ ...device, n: counter })}`,
      });
    }

    if (
      method === 'POST' &&
      path === '/v1/orders' &&
      !PERMISSIONS[session.staff.role].includes('order.create')
    ) {
      return fail(403, 'FORBIDDEN');
    }
    const answer = shop.handle(method, path, query, body, {
      role: session.staff.role,
      stepUpFresh: (stepUps.get(session.token) ?? 0) > now(),
    });
    if (answer) return reply(answer.status, answer.body);

    return fail(404, 'NOT_FOUND');
  }

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://mock.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const injected = options.intercept?.({ method, path: url.pathname, body });
    if (injected) return injected;
    return route(method, url.pathname, new Headers(init?.headers), body, url.searchParams);
  }) as typeof fetch;

  return {
    fetch: mockFetch,
    /** The made-up `/v1/ws`: hand it to `createServices({ createSocket })`. */
    createSocket: shop.createSocket,
    /** Dev: a LINE order arrives by itself (a new-order frame and an alert on every open socket). */
    simulateIncomingOrder: shop.simulateIncomingOrder,
    calls,
    /** A device token the server accepts, as if the owner had registered it earlier. */
    issueDeviceToken(name = 'iPad ตัวอย่าง', kind: 'ipad' | 'iphone' | 'laptop' = 'ipad') {
      counter += 1;
      const device = { id: crypto.randomUUID(), name, kind };
      return { device, deviceToken: `${DEVICE_PREFIX}${encode({ ...device, n: counter })}` };
    },
    /** The server forgets this device (the owner removed it). */
    revoke(token: string) {
      revoked.add(token);
    },
    /** Every session issued so far ends (the server restarted, or it expired). */
    revokeAllSessions() {
      revokedUpTo = counter;
    },
    isStepUpFresh(sessionToken: string) {
      return (stepUps.get(sessionToken) ?? 0) > now();
    },
  };
}

export type MockServer = ReturnType<typeof createMockServer>;
