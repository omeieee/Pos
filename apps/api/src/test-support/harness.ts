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
import {
  type AppEvent,
  createEventBus,
  type EventBus,
  type SecurityAlertEvent,
} from '../events.ts';
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

export interface Menu {
  /** ก๋วยเตี๋ยว ฿50, Grab ฿65. Needs one noodle type; extras are optional (max 3). */
  noodles: string;
  /** น้ำเปล่า ฿10, storefront and LINE only. */
  water: string;
  /** Marked sold out. */
  soldOut: string;
  thin: string;
  wide: string;
  /** +฿5 */
  egg: string;
  /** +฿10 */
  large: string;
  typeGroup: string;
}

export interface Harness {
  app: FastifyInstance;
  db: PgliteDb;
  /** Raw SQL for the few things no repo function offers yet (tests only). */
  client: Awaited<ReturnType<typeof createPgliteDb>>['client'];
  clock: Clock;
  keys: AuthKeys;
  /** Everything published after commit, in order. */
  events: AppEvent[];
  /** The security alerts among them. */
  alerts: SecurityAlertEvent[];
  /** For tests that subscribe their own handler. */
  bus: EventBus;
  /** Menu rows for order tests (built by hand: seed() holds the test PromptPay ID). */
  newMenu(): Promise<Menu>;
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
  const alerts: SecurityAlertEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => {
    events.push(event);
    if (event.type === 'alert.security') alerts.push(event);
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
      recoveryCodeHashes: recoveryCodes.map((code) => hashRecoveryCode(code)),
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

  async function newMenu(): Promise<Menu> {
    const [category] = await db
      .insert(schema.menuCategories)
      .values({ nameTh: `หมวด ${unique()}` })
      .returning();
    const categoryId = category?.id ?? '';
    const [noodles, water, soldOut] = await db
      .insert(schema.menuItems)
      .values([
        {
          categoryId,
          nameTh: 'ก๋วยเตี๋ยวต้มยำ',
          nameEn: 'Tom yum noodles',
          priceSatang: 5000,
          estCostSatang: 2200,
          channels: ['storefront', 'line', 'grab', 'lineman'],
        },
        {
          categoryId,
          nameTh: 'น้ำเปล่า',
          nameEn: 'Water',
          priceSatang: 1000,
          estCostSatang: 400,
          channels: ['storefront', 'line'],
        },
        {
          categoryId,
          nameTh: 'หมด',
          priceSatang: 2500,
          isAvailable: false,
          channels: ['storefront'],
        },
      ])
      .returning();
    await db
      .insert(schema.menuItemChannelPrices)
      .values({ itemId: noodles?.id ?? '', channel: 'grab', priceSatang: 6500 });
    const [typeGroup, extrasGroup] = await db
      .insert(schema.modifierGroups)
      .values([
        { nameTh: 'เส้น', nameEn: 'Noodle', minSelect: 1, maxSelect: 1 },
        { nameTh: 'เพิ่มพิเศษ', nameEn: 'Extras', minSelect: 0, maxSelect: 3 },
      ])
      .returning();
    const [thin, wide, egg, large] = await db
      .insert(schema.modifierOptions)
      .values([
        { groupId: typeGroup?.id ?? '', nameTh: 'เส้นเล็ก', nameEn: 'Thin' },
        { groupId: typeGroup?.id ?? '', nameTh: 'เส้นใหญ่', nameEn: 'Wide' },
        {
          groupId: extrasGroup?.id ?? '',
          nameTh: 'ไข่',
          nameEn: 'Egg',
          priceDeltaSatang: 500,
          costDeltaSatang: 300,
        },
        {
          groupId: extrasGroup?.id ?? '',
          nameTh: 'พิเศษ',
          nameEn: 'Large',
          priceDeltaSatang: 1000,
          costDeltaSatang: 500,
        },
      ])
      .returning();
    await db.insert(schema.menuItemModifierGroups).values([
      { itemId: noodles?.id ?? '', groupId: typeGroup?.id ?? '', sort: 1 },
      { itemId: noodles?.id ?? '', groupId: extrasGroup?.id ?? '', sort: 2 },
    ]);
    return {
      noodles: noodles?.id ?? '',
      water: water?.id ?? '',
      soldOut: soldOut?.id ?? '',
      thin: thin?.id ?? '',
      wide: wide?.id ?? '',
      egg: egg?.id ?? '',
      large: large?.id ?? '',
      typeGroup: typeGroup?.id ?? '',
    };
  }

  return {
    app,
    db,
    client,
    clock,
    keys,
    events,
    alerts,
    bus,
    newMenu,
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
