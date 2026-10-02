import { govCopaySchemeSchema, isCopayAvailable } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { alertReport } from '../alerts.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { currentDeliverySettings, currentPromptpayId } from './service.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner();
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** A fresh owner session that has stepped up (the clock moves so the TOTP codes are new). */
async function ownerStepped() {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
}
async function staffToken(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  token: string | undefined,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

const clearSettings = async () => {
  await h.client.query('delete from settings');
};
const actions = async (entityId: string) => (await h.auditRows(entityId)).map((a) => a.action);

// ---------- who may do what ----------

describe('access', () => {
  const READABLE = [
    'shop',
    'opening-hours',
    'numbering',
    'payments',
    'delivery',
    'promptpay',
    'gov-copay',
  ];

  test('nobody without a session', async () => {
    for (const name of READABLE) {
      expect((await call('GET', `/v1/settings/${name}`, undefined)).statusCode, name).toBe(401);
    }
  });

  test('the kitchen cannot read settings; cashiers, managers and the owner can', async () => {
    const kitchen = await staffToken('kitchen');
    for (const name of READABLE) {
      expect(
        (await call('GET', `/v1/settings/${name}`, kitchen)).statusCode,
        `kitchen ${name}`,
      ).toBe(403);
    }
    for (const who of [
      await staffToken('cashier'),
      await staffToken('manager'),
      await ownerStepped(),
    ]) {
      for (const name of READABLE) {
        expect((await call('GET', `/v1/settings/${name}`, who)).statusCode, name).toBe(200);
      }
    }
  });

  test('ordinary settings: a manager may change them, a cashier may not', async () => {
    await clearSettings();
    const cashier = await staffToken('cashier');
    const manager = await staffToken('manager');
    const body = { expectedVersion: 0, nameTh: 'ร้านทดสอบ' };
    const denied = await call('PATCH', '/v1/settings/shop', cashier, body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await call('PATCH', '/v1/settings/shop', manager, body)).statusCode).toBe(200);
  });

  test('the PromptPay ID and the co-pay scheme: owner only, and only after a fresh step-up', async () => {
    const manager = await staffToken('manager');
    await call('POST', '/v1/auth/step-up', manager, { pin: '4821' }); // even stepped up
    const promptpay = { expectedVersion: 0, idType: 'phone', idValue: '0812345678' };
    const scheme = { expectedVersion: 0, enabled: false };
    for (const [url, body] of [
      ['/v1/settings/promptpay', promptpay],
      ['/v1/settings/gov-copay', scheme],
    ] as const) {
      const res = await call('PATCH', url, manager, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
    h.clock.advanceSeconds(90);
    const signedInOnly = await h.ownerSession(owner);
    for (const [url, body] of [
      ['/v1/settings/promptpay', promptpay],
      ['/v1/settings/gov-copay', scheme],
    ] as const) {
      const res = await call('PATCH', url, signedInOnly, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
  });
});

// ---------- plain key/value settings ----------

describe('shop profile, opening hours, numbering and payment methods', () => {
  test('before anything is saved, GET returns the defaults at version 0', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    const shop = (await call('GET', '/v1/settings/shop', token)).json();
    expect(shop).toMatchObject({ version: 0, value: { nameTh: 'แซ่บโดนเส้น' } });
    const hours = (await call('GET', '/v1/settings/opening-hours', token)).json();
    expect(hours.value).toMatchObject({
      storefront: { openMinute: 660, closeMinute: 1380 },
      delivery: { openMinute: 780, closeMinute: 1380 },
      overrides: [],
    });
    expect((await call('GET', '/v1/settings/numbering', token)).json().value).toEqual({
      cutoffMinutes: 240,
      timeZone: 'Asia/Bangkok',
    });
    expect((await call('GET', '/v1/settings/payments', token)).json().value).toEqual({
      cash: true,
      promptpay: true,
      platform: true,
      other: false,
    });
  });

  test('rows saved by the seed (names only) still read', async () => {
    await clearSettings();
    await h.client.query(
      `insert into settings (key, value) values ('shop', '{"nameTh":"แซ่บโดนเส้น","nameEn":"Saap Don Sen"}')`,
    );
    await h.client.query(
      `insert into settings (key, value) values ('opening_hours', '{"storefront":{"openMinute":660,"closeMinute":1380},"delivery":{"openMinute":780,"closeMinute":1380},"overrides":[]}')`,
    );
    const token = await staffToken('cashier');
    expect((await call('GET', '/v1/settings/shop', token)).json()).toMatchObject({
      version: 1,
      value: { nameTh: 'แซ่บโดนเส้น', nameEn: 'Saap Don Sen', phone: null, address: null },
    });
    expect((await call('GET', '/v1/settings/opening-hours', token)).json()).toMatchObject({
      version: 1,
    });
  });

  test('PATCH creates the row at version 0, then needs the version it saw; rev and version bump', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    const created = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 0,
      nameTh: 'ร้านใหม่',
      phone: '0812345678',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      version: 1,
      value: { nameTh: 'ร้านใหม่', phone: '0812345678' },
    });

    const second = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 1,
      address: 'ชั้น 1',
    });
    expect(second.json()).toMatchObject({
      version: 2,
      value: { nameTh: 'ร้านใหม่', phone: '0812345678', address: 'ชั้น 1' }, // merged, not replaced
    });
    expect(second.json().rev).toBeGreaterThan(created.json().rev);

    const stale = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 1,
      nameTh: 'เก่า',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });

    const again = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 0,
      nameTh: 'อีกที',
    });
    expect(again.statusCode).toBe(409);
  });

  test('refuses a missing version, an empty patch, unknown fields and bad values', async () => {
    const token = await staffToken('manager');
    for (const body of [
      { nameTh: 'x' },
      { expectedVersion: 0 },
      { expectedVersion: 0, logo: 'x' },
      { expectedVersion: 0, nameTh: '   ' },
    ]) {
      const res = await call('PATCH', '/v1/settings/shop', token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  test('a change is audited with before and after, and published once after commit', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    await call('PATCH', '/v1/settings/shop', token, { expectedVersion: 0, nameTh: 'หนึ่ง' });
    const before = h.events.length;
    const res = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 1,
      nameTh: 'สอง',
    });
    const audit = (await h.auditRows('shop')).filter((a) => a.action === 'settings.update');
    expect(audit.at(-1)).toMatchObject({
      entity: 'settings',
      entityId: 'shop',
      before: { nameTh: 'หนึ่ง' },
      after: { nameTh: 'สอง' },
    });
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({
        type: 'settings.updated',
        key: 'shop',
        rev: res.json().rev,
        version: 2,
      }),
    ]);
  });

  test('sending the value it already has changes nothing: no new version, audit row or event', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    await call('PATCH', '/v1/settings/shop', token, { expectedVersion: 0, nameTh: 'เดิม' });
    const auditBefore = (await actions('shop')).length;
    const eventsBefore = h.events.length;
    const res = await call('PATCH', '/v1/settings/shop', token, {
      expectedVersion: 1,
      nameTh: 'เดิม',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 1 });
    expect((await actions('shop')).length).toBe(auditBefore);
    expect(h.events.length).toBe(eventsBefore);
  });

  test('two managers saving at once: one wins, one is told to reload', async () => {
    await clearSettings();
    const a = await staffToken('manager');
    const b = await staffToken('manager');
    await call('PATCH', '/v1/settings/shop', a, { expectedVersion: 0, nameTh: 'เริ่ม' });
    const [x, y] = await Promise.all([
      call('PATCH', '/v1/settings/shop', a, { expectedVersion: 1, nameTh: 'จาก A' }),
      call('PATCH', '/v1/settings/shop', b, { expectedVersion: 1, nameTh: 'จาก B' }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
  });

  test('opening hours: per-weekday rules, per-date overrides and closures are saved and read back', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    const res = await call('PATCH', '/v1/settings/opening-hours', token, {
      expectedVersion: 0,
      weekly: { sun: { storefront: { openMinute: 720, closeMinute: 1200 }, delivery: null } },
      overrides: [
        { date: '2026-12-31', closed: true, note: 'ปีใหม่' },
        { date: '2026-12-25', storefront: { openMinute: 600, closeMinute: 900 } },
      ],
    });
    expect(res.statusCode).toBe(200);
    const back = (await call('GET', '/v1/settings/opening-hours', token)).json();
    expect(back.value.weekly.sun.delivery).toBeNull();
    expect(back.value.overrides).toHaveLength(2);
    // The defaults were kept.
    expect(back.value.storefront).toEqual({ openMinute: 660, closeMinute: 1380 });
  });

  test('opening hours: a window that closes before it opens, or two overrides on one date, are refused', async () => {
    const token = await staffToken('manager');
    for (const body of [
      { expectedVersion: 0, storefront: { openMinute: 900, closeMinute: 600 } },
      {
        expectedVersion: 0,
        overrides: [
          { date: '2026-12-31', closed: true },
          { date: '2026-12-31', closed: true },
        ],
      },
    ]) {
      expect((await call('PATCH', '/v1/settings/opening-hours', token, body)).statusCode).toBe(400);
    }
  });

  test('numbering: the business-day cutoff is saved and is what the order code reads', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    const res = await call('PATCH', '/v1/settings/numbering', token, {
      expectedVersion: 0,
      cutoffMinutes: 360,
    });
    expect(res.json()).toMatchObject({
      version: 1,
      value: { cutoffMinutes: 360, timeZone: 'Asia/Bangkok' },
    });
    // 05:30 in Bangkok is before the new 06:00 cutoff, so it is still the previous business day.
    expect(await currentBusinessDate(h.db, new Date('2027-04-01T22:30:00Z'))).toBe('2027-04-01');
    expect(await currentBusinessDate(h.db, new Date('2027-04-01T23:00:00Z'))).toBe('2027-04-02');
    expect(
      (
        await call('PATCH', '/v1/settings/numbering', token, {
          expectedVersion: 1,
          cutoffMinutes: 1440,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/v1/settings/numbering', token, {
          expectedVersion: 1,
          timeZone: 'Mars/Base',
        })
      ).statusCode,
    ).toBe(400);
  });

  test('payment methods: switches are saved', async () => {
    await clearSettings();
    const token = await staffToken('manager');
    const res = await call('PATCH', '/v1/settings/payments', token, {
      expectedVersion: 0,
      other: true,
      cash: false,
    });
    expect(res.json().value).toEqual({ cash: false, promptpay: true, platform: true, other: true });
  });
});

// ---------- delivery buildings ----------

describe('delivery buildings', () => {
  const DEFAULT_BUILDINGS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];

  test('never saved: GET and the order-side reader both give the eight default buildings at version 0', async () => {
    await clearSettings();
    const token = await staffToken('cashier');
    const res = await call('GET', '/v1/settings/delivery', token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      value: { buildings: DEFAULT_BUILDINGS },
      version: 0,
      rev: 0,
      updatedAt: null,
    });
    expect(await currentDeliverySettings(h.db)).toEqual({ buildings: DEFAULT_BUILDINGS });
  });

  test('a manager replaces the list with PUT (PATCH says the same); a cashier may not', async () => {
    await clearSettings();
    const cashier = await staffToken('cashier');
    const manager = await staffToken('manager');
    const body = { expectedVersion: 0, buildings: ['A1', ' B1 ', 'Tower'] };
    const denied = await call('PUT', '/v1/settings/delivery', cashier, body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });

    const saved = await call('PUT', '/v1/settings/delivery', manager, body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, value: { buildings: ['A1', 'B1', 'Tower'] } });
    expect((await call('GET', '/v1/settings/delivery', cashier)).json().value.buildings).toEqual([
      'A1',
      'B1',
      'Tower',
    ]);
    expect(await currentDeliverySettings(h.db)).toEqual({ buildings: ['A1', 'B1', 'Tower'] });

    const again = await call('PATCH', '/v1/settings/delivery', manager, {
      expectedVersion: 1,
      buildings: ['E1'],
    });
    expect(again.json()).toMatchObject({ version: 2, value: { buildings: ['E1'] } });
  });

  test('needs no step-up: a signed-in manager is enough', async () => {
    await clearSettings();
    const manager = await staffToken('manager'); // never stepped up
    expect(
      (
        await call('PUT', '/v1/settings/delivery', manager, {
          expectedVersion: 0,
          buildings: ['A1'],
        })
      ).statusCode,
    ).toBe(200);
  });

  test('a change is audited with before and after, and published once after commit', async () => {
    await clearSettings();
    const manager = await staffToken('manager');
    await call('PUT', '/v1/settings/delivery', manager, { expectedVersion: 0, buildings: ['A1'] });
    const eventsBefore = h.events.length;
    const res = await call('PUT', '/v1/settings/delivery', manager, {
      expectedVersion: 1,
      buildings: ['A1', 'A2'],
    });
    const audit = (await h.auditRows('delivery')).filter((a) => a.action === 'settings.update');
    expect(audit.at(-1)).toMatchObject({
      entity: 'settings',
      entityId: 'delivery',
      before: { buildings: ['A1'] },
      after: { buildings: ['A1', 'A2'] },
    });
    expect(h.events.slice(eventsBefore)).toEqual([
      expect.objectContaining({
        type: 'settings.updated',
        key: 'delivery',
        rev: res.json().rev,
        version: 2,
        data: { buildings: ['A1', 'A2'] },
      }),
    ]);
  });

  test('sending the list it already has changes nothing', async () => {
    await clearSettings();
    const manager = await staffToken('manager');
    await call('PUT', '/v1/settings/delivery', manager, { expectedVersion: 0, buildings: ['A1'] });
    const auditBefore = (await actions('delivery')).length;
    const res = await call('PUT', '/v1/settings/delivery', manager, {
      expectedVersion: 1,
      buildings: ['A1'],
    });
    expect(res.json()).toMatchObject({ version: 1 });
    expect((await actions('delivery')).length).toBe(auditBefore);
  });

  test('refuses a stale version, a missing version, an empty or duplicated list and extra fields', async () => {
    await clearSettings();
    const manager = await staffToken('manager');
    await call('PUT', '/v1/settings/delivery', manager, { expectedVersion: 0, buildings: ['A1'] });
    const stale = await call('PUT', '/v1/settings/delivery', manager, {
      expectedVersion: 0,
      buildings: ['B1'],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 1 },
    });
    for (const body of [
      { buildings: ['B1'] },
      { expectedVersion: 1 },
      { expectedVersion: 1, buildings: [] },
      { expectedVersion: 1, buildings: ['B1', 'b1'] },
      { expectedVersion: 1, buildings: ['A234567890X'] },
      { expectedVersion: 1, buildings: ['B1'], deliveryFee: 0 },
    ]) {
      const res = await call('PUT', '/v1/settings/delivery', manager, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await currentDeliverySettings(h.db)).toEqual({ buildings: ['A1'] });
  });
});

// ---------- the PromptPay ID ----------

describe('PromptPay ID', () => {
  const PHONE = '0987654321';
  const NATIONAL = '3101234567893';

  test('never saved: GET says null, and nothing is invented', async () => {
    await clearSettings();
    const token = await staffToken('cashier');
    expect((await call('GET', '/v1/settings/promptpay', token)).json()).toMatchObject({
      value: null,
      version: 0,
    });
    expect(await currentPromptpayId(h.db)).toBeNull();
  });

  test('the owner sets it after step-up: audited with a masked value, critical alert, event, QR source updated', async () => {
    await clearSettings();
    const token = await ownerStepped();
    const alertsBefore = h.alerts.length;
    const res = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 1, value: { idType: 'phone', idValue: PHONE } });

    const audit = (await h.auditRows('promptpay')).find(
      (a) => a.action === 'settings.promptpay_change',
    );
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      entity: 'settings',
      before: null,
      after: { idType: 'phone', idMasked: '******4321' },
    });
    expect(h.alerts.slice(alertsBefore)).toEqual([
      expect.objectContaining({
        kind: 'settings.promptpay_changed',
        severity: 'critical',
        staffId: owner.staffId,
      }),
    ]);
    // The QR source reads the current ID from settings.
    expect(await currentPromptpayId(h.db)).toEqual({ idType: 'phone', idValue: PHONE });
  });

  test('every later change raises the alert again and replaces what the QR reads', async () => {
    await clearSettings();
    const t1 = await ownerStepped();
    await call('PATCH', '/v1/settings/promptpay', t1, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    const t2 = await ownerStepped();
    const before = h.alerts.length;
    const res = await call('PATCH', '/v1/settings/promptpay', t2, {
      expectedVersion: 1,
      idType: 'national_id',
      idValue: NATIONAL,
    });
    expect(res.statusCode).toBe(200);
    expect(h.alerts.slice(before)).toHaveLength(1);
    expect(h.alerts.at(-1)).toMatchObject({
      kind: 'settings.promptpay_changed',
      severity: 'critical',
    });
    expect(await currentPromptpayId(h.db)).toEqual({ idType: 'national_id', idValue: NATIONAL });
    const audit = (await h.auditRows('promptpay')).filter(
      (a) => a.action === 'settings.promptpay_change',
    );
    expect(audit.at(-1)).toMatchObject({
      before: { idType: 'phone', idMasked: '******4321' },
      after: { idType: 'national_id', idMasked: '*********7893' },
    });
  });

  test('the full ID is in no audit row, log line, alert or error; only the settings row and the response hold it', async () => {
    await clearSettings();
    const token = await ownerStepped();
    await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 5,
      idType: 'phone',
      idValue: PHONE,
    }); // 409
    await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 1,
      idType: 'phone',
      idValue: '12345',
    }); // 400
    expect(JSON.stringify(await h.auditRows('promptpay'))).not.toContain(PHONE);
    expect(h.logs()).not.toContain(PHONE);
    expect(JSON.stringify(h.alerts)).not.toContain(PHONE);
    // ...and no settings.updated event: the realtime fan-out must not carry the ID to every device.
    const event = h.events.findLast((e) => e.type === 'settings.updated' && e.key === 'promptpay');
    expect(event).toMatchObject({ data: { idType: 'phone', idMasked: '******4321' } });
    expect(JSON.stringify(h.events)).not.toContain(PHONE);
    const bad = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 1,
      idType: 'phone',
      idValue: '12345',
    });
    expect(bad.body).not.toContain('12345');
  });

  test('sending the same ID again is a no-op: no alert, no audit row', async () => {
    await clearSettings();
    const token = await ownerStepped();
    await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    const alerts = h.alerts.length;
    const audits = (await actions('promptpay')).length;
    const res = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 1,
      idType: 'phone',
      idValue: PHONE,
    });
    expect(res.json()).toMatchObject({ version: 1 });
    expect(h.alerts.length).toBe(alerts);
    expect((await actions('promptpay')).length).toBe(audits);
  });

  test('refuses a malformed ID, a wrong type for the value and a missing version', async () => {
    await clearSettings();
    const token = await ownerStepped();
    for (const body of [
      { expectedVersion: 0, idType: 'phone', idValue: '812345678' },
      { expectedVersion: 0, idType: 'phone', idValue: '081-234-5678' },
      { expectedVersion: 0, idType: 'national_id', idValue: PHONE },
      { expectedVersion: 0, idType: 'national_id', idValue: '31012345678ab' },
      { expectedVersion: 0, idType: 'bank', idValue: PHONE },
      { idType: 'phone', idValue: PHONE },
    ]) {
      const res = await call('PATCH', '/v1/settings/promptpay', token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await currentPromptpayId(h.db)).toBeNull();
  });

  test('a stale version is a conflict and changes nothing', async () => {
    await clearSettings();
    const token = await ownerStepped();
    await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    const stale = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: '0811111111',
    });
    expect(stale.statusCode).toBe(409);
    expect(await currentPromptpayId(h.db)).toEqual({ idType: 'phone', idValue: PHONE });
  });

  test('an old session without a fresh step-up cannot change it, and nothing is audited', async () => {
    await clearSettings();
    const token = await ownerStepped();
    h.clock.advanceSeconds(6 * 60); // step-up has run out (5 minutes)
    const audited = (await actions('promptpay')).length;
    const res = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion: 0,
      idType: 'phone',
      idValue: PHONE,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await currentPromptpayId(h.db)).toBeNull();
    expect((await actions('promptpay')).length).toBe(audited);
  });
});

// ---------- changing the PromptPay ID while PromptPay payments are open ----------

describe('PromptPay ID change warns about open PromptPay payments (owner decision 2026-10-02)', () => {
  const OLD_ID = '0987654321';
  const NEW_ID = '0899991234';
  let menuId = '';
  let thinId = '';

  async function cashier() {
    return staffToken('cashier');
  }

  async function newOrderWithPromptpay(token: string) {
    if (!menuId) {
      const menu = await h.newMenu();
      menuId = menu.noodles;
      thinId = menu.thin;
    }
    const order = await call('POST', '/v1/orders', token, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: menuId, qty: 1, modifierOptionIds: [thinId] }],
    });
    expect(order.statusCode, order.body).toBe(201);
    const payment = await call('POST', `/v1/orders/${order.json().id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'promptpay',
    });
    expect(payment.statusCode, payment.body).toBe(201);
    return payment.json().payment.id as string;
  }

  async function setId(idValue: string, expectedVersion: number) {
    const token = await ownerStepped();
    const res = await call('PATCH', '/v1/settings/promptpay', token, {
      expectedVersion,
      idType: 'phone',
      idValue,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  test('no open PromptPay payment: the alert and the audit row say 0', async () => {
    await clearSettings();
    await setId(OLD_ID, 0);
    const alerts = h.alerts.length;
    await setId(NEW_ID, 1);
    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({
        kind: 'settings.promptpay_changed',
        severity: 'critical',
        detail: { openPromptpayPayments: 0 },
      }),
    ]);
    const audit = (await h.auditRows('promptpay')).findLast(
      (a) => a.action === 'settings.promptpay_change',
    );
    expect(audit?.after).toEqual({
      idType: 'phone',
      idMasked: '******1234',
      openPromptpayPayments: 0,
    });
  });

  test('pending and claimed PromptPay payments are counted, others are not, and none is cancelled', async () => {
    await clearSettings();
    await setId(OLD_ID, 0);
    const token = await cashier();
    const manager = await staffToken('manager');
    const pending = await newOrderWithPromptpay(token);
    const claimed = await newOrderWithPromptpay(token);
    expect((await call('POST', `/v1/payments/${claimed}/claim`, token, {})).statusCode).toBe(200);
    const confirmed = await newOrderWithPromptpay(token);
    expect((await call('POST', `/v1/payments/${confirmed}/confirm`, manager, {})).statusCode).toBe(
      200,
    );
    const cancelled = await newOrderWithPromptpay(token);
    await h.client.query("update payments set status = 'cancelled' where id = $1", [cancelled]);
    // Cash is confirmed at once: it never counts.
    const cashOrder = await call('POST', '/v1/orders', token, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: menuId, qty: 1, modifierOptionIds: [thinId] }],
    });
    await call('POST', `/v1/orders/${cashOrder.json().id}/payments`, token, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 10000,
    });

    const alerts = h.alerts.length;
    await setId(NEW_ID, 1);

    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({
        kind: 'settings.promptpay_changed',
        severity: 'critical',
        detail: { openPromptpayPayments: 2 },
      }),
    ]);
    const audit = (await h.auditRows('promptpay')).findLast(
      (a) => a.action === 'settings.promptpay_change',
    );
    expect(audit?.before).toEqual({ idType: 'phone', idMasked: '******4321' });
    expect(audit?.after).toEqual({
      idType: 'phone',
      idMasked: '******1234',
      openPromptpayPayments: 2,
    });

    // Warn, do not cancel: the payments are exactly as they were.
    const status = async (id: string) =>
      (await h.client.query<{ status: string }>('select status from payments where id = $1', [id]))
        .rows[0]?.status;
    expect(await status(pending)).toBe('pending');
    expect(await status(claimed)).toBe('claimed');
    expect(await status(confirmed)).toBe('confirmed');
  });

  test('neither the old nor the new full ID is in the alert, its report, the audit row or the logs', async () => {
    await clearSettings();
    await setId(OLD_ID, 0);
    await newOrderWithPromptpay(await cashier());
    const alerts = h.alerts.length;
    await setId(NEW_ID, 1);
    const alert = h.alerts.slice(alerts)[0];
    if (!alert) throw new Error('no alert was raised');
    const everywhere = JSON.stringify([alert, alertReport(alert), await h.auditRows('promptpay')]);
    for (const clear of [OLD_ID, NEW_ID]) {
      expect(everywhere).not.toContain(clear);
      expect(h.logs()).not.toContain(clear);
    }
    expect(alertReport(alert).extra).toMatchObject({ openPromptpayPayments: expect.any(Number) });
  });
});

// ---------- the government co-pay scheme ----------

describe('government co-pay scheme', () => {
  const full = {
    expectedVersion: 0,
    nameTh: 'โครงการทดสอบ',
    govShareBp: 6000,
    govDailyCapSatang: 20000,
    govTotalCapSatang: 100000,
    activeFrom: '2026-10-01',
    activeTo: '2026-11-30',
    activeFromMinute: 360,
    activeToMinute: 1380,
    channels: ['storefront'],
    enabled: false,
  };
  const reset = async () => {
    await h.client.query('delete from gov_copay_schemes');
  };

  test('no scheme saved: GET says null', async () => {
    await reset();
    const token = await staffToken('cashier');
    expect((await call('GET', '/v1/settings/gov-copay', token)).json()).toEqual({ scheme: null });
  });

  test('the owner creates it (disabled), audited and alerted; GET maps to the shared scheme schema', async () => {
    await reset();
    const token = await ownerStepped();
    const alerts = h.alerts.length;
    const res = await call('PATCH', '/v1/settings/gov-copay', token, full);
    expect(res.statusCode).toBe(200);
    const scheme = res.json().scheme;
    expect(scheme).toMatchObject({
      nameTh: 'โครงการทดสอบ',
      version: 1,
      enabled: false,
      govShareBp: 6000,
    });

    const read = (await call('GET', '/v1/settings/gov-copay', await staffToken('cashier'))).json()
      .scheme;
    expect(govCopaySchemeSchema.safeParse(read).success).toBe(true);
    const audit = (await h.auditRows(scheme.id)).find(
      (a) => a.action === 'settings.gov_copay_change',
    );
    expect(audit).toMatchObject({ actorId: owner.staffId, entity: 'gov_copay_schemes' });
    expect(h.alerts.slice(alerts)).toEqual([
      expect.objectContaining({
        kind: 'settings.gov_copay_changed',
        severity: 'warn',
        staffId: owner.staffId,
      }),
    ]);
  });

  test('enabling it makes isCopayAvailable true inside its dates and hours, false outside', async () => {
    await reset();
    const token = await ownerStepped();
    const created = await call('PATCH', '/v1/settings/gov-copay', token, full);
    const t2 = await ownerStepped();
    const on = await call('PATCH', '/v1/settings/gov-copay', t2, {
      expectedVersion: created.json().scheme.version,
      enabled: true,
    });
    expect(on.statusCode).toBe(200);
    const scheme = govCopaySchemeSchema.parse(on.json().scheme);
    expect(
      isCopayAvailable(scheme, new Date('2026-10-15T05:00:00Z'), 'storefront', 'takeaway'),
    ).toBe(true); // 12:00 Bangkok
    expect(
      isCopayAvailable(scheme, new Date('2026-10-15T17:00:00Z'), 'storefront', 'takeaway'),
    ).toBe(false); // 00:00
    expect(
      isCopayAvailable(scheme, new Date('2026-12-15T05:00:00Z'), 'storefront', 'takeaway'),
    ).toBe(false); // after the round
    expect(isCopayAvailable(scheme, new Date('2026-10-15T05:00:00Z'), 'line', 'pickup')).toBe(
      false,
    );
  });

  test('enabling is refused when the dates or the hours do not make sense, and nothing changes', async () => {
    await reset();
    const created = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), full);
    const version = created.json().scheme.version;
    for (const bad of [
      { enabled: true, activeFrom: '2026-12-01' }, // starts after it ends
      { enabled: true, activeFromMinute: 1380, activeToMinute: 360 },
      { enabled: true, activeFromMinute: 600, activeToMinute: 600 },
      { enabled: true, channels: [] },
      { enabled: true, govShareBp: 0 },
    ]) {
      const res = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
        expectedVersion: version,
        ...bad,
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    const now = (await call('GET', '/v1/settings/gov-copay', await ownerStepped())).json().scheme;
    expect(now).toMatchObject({ version, enabled: false, activeFrom: '2026-10-01' });
  });

  test('inconsistent dates are refused even while it stays disabled', async () => {
    await reset();
    const res = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
      ...full,
      activeFrom: '2026-12-01',
      activeTo: '2026-11-01',
    });
    expect(res.statusCode).toBe(400);
  });

  test('creating needs every field and a name; a partial body is refused', async () => {
    await reset();
    const res = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
      expectedVersion: 0,
      enabled: true,
    });
    expect(res.statusCode).toBe(400);
  });

  test('works on a row saved the way the seed saves it', async () => {
    await reset();
    await h.client.query(`insert into gov_copay_schemes
      (code, name_th, gov_share_bp, gov_daily_cap_satang, gov_total_cap_satang, active_from, active_to,
       active_from_minute, active_to_minute, channels, enabled)
      values ('seeded', 'ไทยช่วยไทย พลัส 60/40', 6000, 20000, 100000, '2026-10-01', '2026-11-30', 360, 1380, '{storefront}', false)`);
    const token = await ownerStepped();
    const read = (await call('GET', '/v1/settings/gov-copay', token)).json().scheme;
    expect(govCopaySchemeSchema.safeParse(read).success).toBe(true);
    const on = await call('PATCH', '/v1/settings/gov-copay', token, {
      expectedVersion: read.version,
      enabled: true,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().scheme).toMatchObject({ enabled: true, version: read.version + 1 });
  });

  test('needs the version it saw; a stale one is a conflict', async () => {
    await reset();
    const created = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), full);
    const v = created.json().scheme.version;
    const first = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
      expectedVersion: v,
      govShareBp: 5000,
    });
    expect(first.statusCode).toBe(200);
    const stale = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
      expectedVersion: v,
      govShareBp: 4000,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: v + 1 },
    });
  });

  test('every change records what changed, before and after', async () => {
    await reset();
    const created = await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), full);
    const { id, version } = created.json().scheme;
    await call('PATCH', '/v1/settings/gov-copay', await ownerStepped(), {
      expectedVersion: version,
      govShareBp: 5000,
      enabled: true,
    });
    const audit = (await h.auditRows(id)).filter((a) => a.action === 'settings.gov_copay_change');
    expect(audit.at(-1)).toMatchObject({
      before: { govShareBp: 6000, enabled: false },
      after: { govShareBp: 5000, enabled: true },
    });
  });
});

describe('what the settings routes leave out', () => {
  test('no hash, token or credential field appears in any settings response', async () => {
    const token = await ownerStepped();
    for (const name of [
      'shop',
      'opening-hours',
      'numbering',
      'payments',
      'delivery',
      'promptpay',
      'gov-copay',
    ]) {
      const body = (await call('GET', `/v1/settings/${name}`, token)).body;
      expect(body, name).not.toMatch(/hash|token|secret|password/i);
    }
  });
});
