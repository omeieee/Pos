/**
 * Test harness: the real app (buildApp + registerV1) on an in-memory Postgres (PGlite) with
 * every migration applied, a controllable clock, a captured log stream and fixture builders.
 * It does not call seed(), which holds the test PromptPay ID.
 *
 * audit_log is append-only, so tests make unique accounts and filter audit rows by entity id.
 */
import { authRepo, schema } from '@sds/db';
import { createPgliteDb, type PgliteDb } from '@sds/db/pglite';
import { PERMISSIONS, type Permission, type StaffRole } from '@sds/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.ts';
import {
  type AuthKeys,
  deriveAuthKeys,
  encryptSecret,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  hashToken,
  newRecoveryCodes,
  newToken,
} from '../auth/crypto.ts';
import { createGuard } from '../auth/guards.ts';
import { type AuthPolicy, DEFAULT_AUTH_POLICY } from '../auth/policy.ts';
import type { AuthContext } from '../auth/service.ts';
import { generateTotpSecret, hotp, timeStep } from '../auth/totp.ts';
import { type AppEvent, createEventBus } from '../events.ts';
import { registerV1 } from '../v1.ts';

// Test-only key, not a secret.
export const TEST_MASTER_KEY = Buffer.alloc(32, 7);

export interface Clock {
  now(): Date;
  set(iso: string): void;
  advanceSeconds(seconds: number): void;
}

function createClock(start: string): Clock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso).getTime();
    },
    advanceSeconds: (seconds) => {
      current += seconds * 1000;
    },
  };
}

export interface OwnerFixture {
  staffId: string;
  email: string;
  password: string;
  pin: string | undefined;
  totpSecret: Buffer;
  recoveryCodes: string[];
  /** The TOTP code for the harness clock, `stepsAhead` 30-second steps from now. */
  totp(stepsAhead?: number): string;
}

export interface Harness {
  app: FastifyInstance;
  db: PgliteDb;
  /** Raw SQL for the few things no repo function offers yet (tests only). */
  client: Awaited<ReturnType<typeof createPgliteDb>>['client'];
  clock: Clock;
  keys: AuthKeys;
  /** Alerts and other events published after commit. */
  events: AppEvent[];
  /** Everything the logger wrote, as one string. */
  logs(): string;
  newOwner(overrides?: { pin?: string }): Promise<OwnerFixture>;
  newStaff(role: Exclude<StaffRole, 'owner'>, pin: string): Promise<{ id: string; pin: string }>;
  newDevice(kind?: 'ipad' | 'iphone' | 'laptop' | 'print_agent' | 'display'): Promise<{
    id: string;
    token: string;
  }>;
  revokeDevice(deviceId: string): Promise<void>;
  /** Signs the owner in over HTTP and returns the bearer token. */
  ownerSession(owner: OwnerFixture, deviceToken?: string): Promise<string>;
  /** Signs a staff member in with a PIN over HTTP and returns the bearer token. */
  pinSession(deviceToken: string, staffId: string, pin: string): Promise<string>;
  /** Owner session that has also stepped up. */
  steppedUpOwner(owner: OwnerFixture): Promise<string>;
  /** Calls a test route guarded by `permission` (or by a session only, when omitted). */
  probe(token: string | undefined, permission?: Permission): Promise<LightMyRequestResponse>;
  /** A new client IP, so one test's requests do not count against another's rate limit. */
  nextIp(): string;
  auditRows(entityId: string): Promise<(typeof schema.auditLog.$inferSelect)[]>;
  close(): Promise<void>;
}

export const START_TIME = '2026-10-01T03:00:00.000Z';

export async function createHarness(
  options: { policy?: Partial<AuthPolicy> } = {},
): Promise<Harness> {
  const { db, client } = await createPgliteDb();
  const clock = createClock(START_TIME);
  const keys = deriveAuthKeys(TEST_MASTER_KEY);
  const events: AppEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => {
    events.push(event);
  });
  const lines: string[] = [];

  const app = await buildApp({
    config: { corsOrigins: [], version: 'test' },
    checkDb: async () => {},
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });
  const policy = { ...DEFAULT_AUTH_POLICY, ...options.policy };
  await registerV1(app, {
    db,
    authSecretKey: TEST_MASTER_KEY,
    events: bus,
    now: clock.now,
    policy,
  });

  // One probe route per permission, behind the real guard, to test the RBAC matrix.
  const guard = createGuard({
    db,
    keys,
    policy,
    now: clock.now,
    events: bus,
  } satisfies AuthContext);
  await app.register(async (scope) => {
    scope.decorateRequest('auth', null);
    scope.get('/__probe/session', { preHandler: guard() }, async () => ({ ok: true }));
    for (const permission of PERMISSIONS) {
      scope.get(`/__probe/${permission}`, { preHandler: guard(permission) }, async () => ({
        ok: true,
      }));
    }
  });
  await app.ready();

  const unique = () => crypto.randomUUID().slice(0, 8);
  let ipCounter = 0;
  const nextIp = () => {
    ipCounter += 1;
    return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.1`;
  };

  async function newOwner(overrides: { pin?: string } = {}): Promise<OwnerFixture> {
    const email = `owner-${unique()}@example.test`;
    const password = `pw-${unique()}-${unique()}`;
    const totpSecret = generateTotpSecret();
    // Straight into the repo: createOwner refuses a second owner, and tests need several.
    const recoveryCodes = newRecoveryCodes(8);
    const { staffId } = await authRepo.insertOwner(db, {
      email,
      displayName: 'Test Owner',
      passwordHash: await hashPassword(password),
      pinHash: overrides.pin === undefined ? null : await hashPin(overrides.pin, keys),
      encryptTotpSecret: (id) => encryptSecret(totpSecret, keys.totpKey, id),
      recoveryCodeHashes: recoveryCodes.map((code) => hashRecoveryCode(code, keys)),
    });
    return {
      staffId,
      email,
      password,
      pin: overrides.pin,
      totpSecret,
      recoveryCodes,
      totp: (stepsAhead = 0) => hotp(totpSecret, timeStep(clock.now().getTime()) + stepsAhead),
    };
  }

  async function newStaff(role: Exclude<StaffRole, 'owner'>, pin: string) {
    const [row] = await db
      .insert(schema.staff)
      .values({ displayName: `${role}-${unique()}`, role, pinHash: await hashPin(pin, keys) })
      .returning({ id: schema.staff.id });
    return { id: row?.id ?? '', pin };
  }

  async function newDevice(
    kind: 'ipad' | 'iphone' | 'laptop' | 'print_agent' | 'display' = 'ipad',
  ) {
    const token = newToken('sds_dev');
    const device = await authRepo.insertDevice(db, {
      name: `device-${unique()}`,
      kind,
      tokenHash: hashToken(token),
    });
    return { id: device.id, token };
  }

  async function revokeDevice(deviceId: string) {
    // Device management is a later task; tests reach the column through the raw client.
    await client.query('update devices set revoked_at = $1 where id = $2', [
      clock.now().toISOString(),
      deviceId,
    ]);
  }

  async function ownerSession(owner: OwnerFixture, deviceToken?: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      remoteAddress: nextIp(),
      headers: deviceToken ? { 'x-device-token': deviceToken } : {},
      payload: { email: owner.email, password: owner.password, totp: owner.totp() },
    });
    if (res.statusCode !== 200) throw new Error(`owner login failed: ${res.statusCode}`);
    return (res.json() as { sessionToken: string }).sessionToken;
  }

  async function pinSession(deviceToken: string, staffId: string, pin: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      remoteAddress: nextIp(),
      headers: { 'x-device-token': deviceToken },
      payload: { staffId, pin },
    });
    if (res.statusCode !== 200) throw new Error(`pin login failed: ${res.statusCode}`);
    return (res.json() as { sessionToken: string }).sessionToken;
  }

  async function steppedUpOwner(owner: OwnerFixture) {
    const token = await ownerSession(owner);
    // Signing in does not count as step-up; the next TOTP step is a fresh code.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up',
      remoteAddress: nextIp(),
      headers: { authorization: `Bearer ${token}` },
      payload: { password: owner.password, totp: owner.totp(1) },
    });
    if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.statusCode}`);
    return token;
  }

  return {
    app,
    db,
    client,
    clock,
    keys,
    events,
    logs: () => lines.join(''),
    newOwner,
    newStaff,
    newDevice,
    revokeDevice,
    ownerSession,
    pinSession,
    steppedUpOwner,
    nextIp,
    probe: (token, permission) =>
      app.inject({
        method: 'GET',
        url: `/__probe/${permission ?? 'session'}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    async auditRows(entityId) {
      const all = await db.select().from(schema.auditLog);
      return all.filter((row) => row.entityId === entityId);
    },
    async close() {
      await app.close();
      await client.close();
    },
  };
}
