import type { ExpenseCategoriesResponse, ExpenseDto, ExpenseList } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
let manager: string;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner();
  device = await h.newDevice();
  manager = await staff('manager');
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function staff(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return h.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

/** The harness clock starts at 10:00 Bangkok on 2026-10-01, so that is the business day. */
const TODAY = '2026-10-01';
const gas = { category: 'gas', amountSatang: 25000 };
const create = async (body: Record<string, unknown> = gas, token = manager) => {
  const res = await call('POST', '/v1/expenses', token, body);
  return { res, dto: res.json() as ExpenseDto };
};
const actions = async (id: string) => (await h.auditRows(id)).map((a) => a.action);
const expenseEvents = () => h.events.filter((e) => e.type === 'expense.upserted');

describe('access', () => {
  test('nobody without a session', async () => {
    expect(
      (await call('GET', `/v1/expenses?from=${TODAY}&to=${TODAY}`, undefined)).statusCode,
    ).toBe(401);
    expect((await call('POST', '/v1/expenses', undefined, gas)).statusCode).toBe(401);
    expect((await call('GET', '/v1/expenses/categories', undefined)).statusCode).toBe(401);
  });

  test('cashier and kitchen are refused everywhere; manager and owner may use it', async () => {
    const { dto } = await create();
    for (const role of ['cashier', 'kitchen'] as const) {
      const token = await staff(role);
      for (const [method, url, body] of [
        ['GET', `/v1/expenses?from=${TODAY}&to=${TODAY}`, undefined],
        ['POST', '/v1/expenses', gas],
        ['PATCH', `/v1/expenses/${dto.id}`, { expectedVersion: 1, note: 'x' }],
        ['POST', `/v1/expenses/${dto.id}/void`, { expectedVersion: 1, reason: 'x' }],
        ['GET', '/v1/expenses/categories', undefined],
        ['PUT', '/v1/expenses/categories', { expectedVersion: 0, categories: [] }],
      ] as const) {
        const res = await call(method, url, token, body);
        expect(res.statusCode, `${role} ${method} ${url}`).toBe(403);
      }
    }
    h.clock.advanceSeconds(90);
    const ownerToken = await h.ownerSession(owner);
    expect((await call('POST', '/v1/expenses', ownerToken, gas)).statusCode).toBe(201);
  });
});

describe('create', () => {
  test('201 with the server-side business date, the creator, audit and one event after commit', async () => {
    const eventsBefore = expenseEvents().length;
    const { res, dto } = await create({ ...gas, vendor: ' ร้านแก๊ส ', note: 'ถังใหญ่' });
    expect(res.statusCode).toBe(201);
    expect(dto).toMatchObject({
      businessDate: TODAY,
      category: 'gas',
      amountSatang: 25000,
      vendor: 'ร้านแก๊ส',
      note: 'ถังใหญ่',
      hasReceipt: false,
      voided: false,
      voidedAt: null,
      voidReason: null,
      version: 1,
    });
    expect(dto.createdByStaffId).toBeTruthy();
    const audit = (await h.auditRows(dto.id)).find((a) => a.action === 'expense.create');
    expect(audit).toMatchObject({
      actorType: 'staff',
      entity: 'expenses',
      after: { businessDate: TODAY, category: 'gas', amountSatang: 25000 },
    });
    const events = expenseEvents().slice(eventsBefore);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'expense.upserted', id: dto.id, rev: dto.rev });
  });

  test('a past date is kept, and so is a date after today (customers may book in advance)', async () => {
    const past = await create({ ...gas, businessDate: '2026-09-28' });
    expect(past.dto.businessDate).toBe('2026-09-28');
    const future = await call('POST', '/v1/expenses', manager, {
      ...gas,
      businessDate: '2026-10-02',
    });
    expect(future.statusCode).toBe(201);
    expect(future.json()).toMatchObject({ businessDate: '2026-10-02' });
  });

  test('the date follows the business-day cutoff, not the calendar', async () => {
    // At 10:00 Bangkok a cutoff of 11:00 still belongs to the previous business day.
    const set = await call('PATCH', '/v1/settings/numbering', manager, {
      expectedVersion: 0,
      cutoffMinutes: 660,
    });
    expect(set.statusCode).toBe(200);
    try {
      const { dto } = await create();
      expect(dto.businessDate).toBe('2026-09-30');
      // the calendar day is now after the business day, and that is allowed too
      const today = await call('POST', '/v1/expenses', manager, { ...gas, businessDate: TODAY });
      expect(today.statusCode).toBe(201);
      expect(today.json()).toMatchObject({ businessDate: TODAY });
    } finally {
      await h.client.query("delete from settings where key = 'business_day'");
    }
  });

  test('an unknown category is refused and nothing is written or published', async () => {
    const before = expenseEvents().length;
    const res = await call('POST', '/v1/expenses', manager, { ...gas, category: 'lunch_boxes' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_EXPENSE_CATEGORY' });
    expect(expenseEvents().length).toBe(before);
  });

  test('amount must be a positive whole number; a client total or a receipt key is refused', async () => {
    for (const body of [
      { ...gas, amountSatang: 0 },
      { ...gas, amountSatang: -5 },
      { ...gas, amountSatang: 12.5 },
      { ...gas, amountSatang: '250' },
      { ...gas, totalSatang: 25000 },
      { ...gas, receiptImageKey: 'k' },
      { amountSatang: 100 },
    ]) {
      const res = await call('POST', '/v1/expenses', manager, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});

describe('idempotency', () => {
  test('the same request id and content: 200 with the same row, one audit row, one event', async () => {
    const clientRequestId = crypto.randomUUID();
    const first = await create({ ...gas, clientRequestId });
    expect(first.res.statusCode).toBe(201);
    const events = expenseEvents().length;
    const again = await call('POST', '/v1/expenses', manager, { ...gas, clientRequestId });
    expect(again.statusCode).toBe(200);
    expect((again.json() as ExpenseDto).id).toBe(first.dto.id);
    expect((await actions(first.dto.id)).filter((a) => a === 'expense.create')).toHaveLength(1);
    expect(expenseEvents().length).toBe(events);
  });

  test('the same request id with other content is 409', async () => {
    const clientRequestId = crypto.randomUUID();
    await create({ ...gas, clientRequestId });
    const res = await call('POST', '/v1/expenses', manager, {
      ...gas,
      amountSatang: 1,
      clientRequestId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('an Idempotency-Key header must say the same as clientRequestId', async () => {
    const clientRequestId = crypto.randomUUID();
    const ok = await call(
      'POST',
      '/v1/expenses',
      manager,
      { ...gas, clientRequestId },
      { 'idempotency-key': clientRequestId },
    );
    expect(ok.statusCode).toBe(201);
    const bad = await call(
      'POST',
      '/v1/expenses',
      manager,
      { ...gas, clientRequestId },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
  });
});

describe('patch', () => {
  test('changes fields, bumps the version, audits before and after, publishes', async () => {
    const { dto } = await create();
    const events = expenseEvents().length;
    const res = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: dto.version,
      amountSatang: 27000,
      note: 'แก้ยอด',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amountSatang: 27000, note: 'แก้ยอด', version: 2 });
    const audit = (await h.auditRows(dto.id)).find((a) => a.action === 'expense.update');
    expect(audit).toMatchObject({
      before: { amountSatang: 25000, note: null },
      after: { amountSatang: 27000, note: 'แก้ยอด' },
    });
    expect(expenseEvents().length).toBe(events + 1);
  });

  test('a stale version is 409 and changes nothing; sending the same values changes nothing', async () => {
    const { dto } = await create();
    const stale = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 7,
      note: 'x',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 1 },
    });
    const events = expenseEvents().length;
    const same = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 1,
      amountSatang: 25000,
    });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ version: 1 });
    expect(await actions(dto.id)).toEqual(['expense.create']);
    expect(expenseEvents().length).toBe(events);
  });

  test('a new category is checked, a later date is allowed; an unknown id is 404; a body without fields is 400', async () => {
    const { dto } = await create();
    const unknown = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 1,
      category: 'nope',
    });
    expect(unknown.json()).toMatchObject({ code: 'UNKNOWN_EXPENSE_CATEGORY' });
    const future = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 1,
      businessDate: '2026-12-01',
    });
    expect(future.statusCode).toBe(200);
    expect(future.json()).toMatchObject({ businessDate: '2026-12-01', version: 2 });
    expect(
      (
        await call('PATCH', `/v1/expenses/${crypto.randomUUID()}`, manager, {
          expectedVersion: 1,
          note: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', `/v1/expenses/${dto.id}`, manager, { expectedVersion: 1 })).statusCode,
    ).toBe(400);
  });
});

describe('void', () => {
  test('marks the row voided with a reason, keeps it, audits and publishes; a second void is 409', async () => {
    const { dto } = await create();
    const events = expenseEvents().length;
    const res = await call('POST', `/v1/expenses/${dto.id}/void`, manager, {
      expectedVersion: 1,
      reason: 'ลงผิดวัน',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ voided: true, voidReason: 'ลงผิดวัน', version: 2 });
    expect((res.json() as ExpenseDto).voidedAt).toBeTruthy();
    expect(await actions(dto.id)).toEqual(['expense.create', 'expense.void']);
    expect(expenseEvents().length).toBe(events + 1);

    const again = await call('POST', `/v1/expenses/${dto.id}/void`, manager, {
      expectedVersion: 2,
      reason: 'again',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'EXPENSE_VOIDED' });
  });

  test('a voided expense cannot be changed', async () => {
    const { dto } = await create();
    await call('POST', `/v1/expenses/${dto.id}/void`, manager, {
      expectedVersion: 1,
      reason: 'x',
    });
    const res = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 2,
      note: 'y',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'EXPENSE_VOIDED' });
  });

  test('a stale version, a missing reason and an unknown id are refused', async () => {
    const { dto } = await create();
    const stale = await call('POST', `/v1/expenses/${dto.id}/void`, manager, {
      expectedVersion: 5,
      reason: 'x',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      (await call('POST', `/v1/expenses/${dto.id}/void`, manager, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', `/v1/expenses/${crypto.randomUUID()}/void`, manager, {
          expectedVersion: 1,
          reason: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });

  test('there is no DELETE route', async () => {
    const { dto } = await create();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/v1/expenses/${dto.id}`,
      headers: { authorization: `Bearer ${manager}` },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('list', () => {
  test('by business date range, inclusive; voided rows show with a flag but are not in the total', async () => {
    const d = (businessDate: string, amountSatang: number) =>
      create({ category: 'rent', amountSatang, businessDate });
    await d('2026-08-01', 1000);
    const a = await d('2026-08-02', 2000);
    await d('2026-08-31', 4000);
    await d('2026-09-01', 8000);
    await call('POST', `/v1/expenses/${a.dto.id}/void`, manager, {
      expectedVersion: 1,
      reason: 'x',
    });

    const res = await call('GET', '/v1/expenses?from=2026-08-01&to=2026-08-31', manager);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as ExpenseList;
    expect(body.expenses.map((e) => [e.businessDate, e.amountSatang, e.voided])).toEqual([
      ['2026-08-01', 1000, false],
      ['2026-08-02', 2000, true],
      ['2026-08-31', 4000, false],
    ]);
    expect(body.totalSatang).toBe(5000);
  });

  test('a bad or too long range is 400', async () => {
    for (const q of [
      '',
      '?from=2026-08-01',
      '?from=2026-09-01&to=2026-08-01',
      '?from=2025-01-01&to=2026-10-01',
      '?from=x&to=y',
    ]) {
      const res = await call('GET', `/v1/expenses${q}`, manager);
      expect(res.statusCode, q).toBe(400);
    }
  });
});

describe('categories', () => {
  const put = (token: string, body: unknown) => call('PUT', '/v1/expenses/categories', token, body);
  const entry = (key: string, nameTh: string, active = true) => ({ key, nameTh, active });
  const read = async () =>
    (await call('GET', '/v1/expenses/categories', manager)).json() as ExpenseCategoriesResponse;

  test('never saved: the nine defaults at version 0', async () => {
    await h.client.query("delete from settings where key = 'expense_categories'");
    const body = await read();
    expect(body.version).toBe(0);
    expect(body.value.categories.map((c) => c.key)).toEqual([
      'ingredients',
      'packaging',
      'gas',
      'utilities',
      'rent',
      'staff',
      'platform_fees',
      'equipment',
      'other',
    ]);
  });

  test('adding categories: saved, audited, no settings frame, then usable on an expense', async () => {
    const current = (await read()).value.categories;
    const eventsBefore = h.events.length;
    const res = await put(manager, {
      expectedVersion: 0,
      categories: [...current, entry('lunch_boxes', 'กล่องข้าว'), entry('verify_fees', 'ค่าตรวจสลิป')],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 1 });
    expect((res.json() as ExpenseCategoriesResponse).value.categories).toHaveLength(11);
    const audit = (await h.auditRows('expense_categories')).find(
      (a) => a.action === 'expense.categories_update',
    );
    expect(audit).toMatchObject({
      entity: 'settings',
      after: { added: ['lunch_boxes', 'verify_fees'] },
    });
    expect(h.events.slice(eventsBefore).some((e) => e.type === 'settings.updated')).toBe(false);

    const used = await create({ category: 'lunch_boxes', amountSatang: 4500 });
    expect(used.res.statusCode).toBe(201);
  });

  test('changing the buying goods flag is saved and audited by key', async () => {
    const cur = await read();
    const res = await put(manager, {
      expectedVersion: cur.version,
      categories: cur.value.categories.map((c) =>
        c.key === 'lunch_boxes' ? { ...c, buyingGoods: true } : c,
      ),
    });
    expect(res.statusCode).toBe(200);
    const saved = (res.json() as ExpenseCategoriesResponse).value.categories;
    expect(saved.find((c) => c.key === 'lunch_boxes')?.buyingGoods).toBe(true);
    const audits = (await h.auditRows('expense_categories')).filter(
      (a) => a.action === 'expense.categories_update',
    );
    expect(audits[audits.length - 1]?.after).toMatchObject({ buyingGoodsChanged: ['lunch_boxes'] });
  });

  test('a list may not drop a key; it may switch one off', async () => {
    const cur = await read();
    const dropped = await put(manager, {
      expectedVersion: cur.version,
      categories: cur.value.categories.slice(1),
    });
    expect(dropped.statusCode).toBe(422);
    expect(dropped.json()).toMatchObject({
      code: 'EXPENSE_CATEGORY_REMOVED',
      details: { keys: ['ingredients'] },
    });
    const off = await put(manager, {
      expectedVersion: cur.version,
      categories: cur.value.categories.map((c) =>
        c.key === 'verify_fees' ? { ...c, active: false } : c,
      ),
    });
    expect(off.statusCode).toBe(200);
  });

  test('a switched-off key is refused for new expenses; an old expense on it can still be edited', async () => {
    const { dto } = await create({ category: 'lunch_boxes', amountSatang: 100 });
    const cur = await read();
    await put(manager, {
      expectedVersion: cur.version,
      categories: cur.value.categories.map((c) =>
        c.key === 'lunch_boxes' ? { ...c, active: false } : c,
      ),
    });
    const refused = await call('POST', '/v1/expenses', manager, {
      category: 'lunch_boxes',
      amountSatang: 5,
    });
    expect(refused.json()).toMatchObject({ code: 'UNKNOWN_EXPENSE_CATEGORY' });
    // Same category as before: allowed. Moving away and back: refused.
    const edit = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 1,
      note: 'ok',
      category: 'lunch_boxes',
    });
    expect(edit.statusCode).toBe(200);
    const move = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 2,
      category: 'gas',
    });
    expect(move.statusCode).toBe(200);
    const back = await call('PATCH', `/v1/expenses/${dto.id}`, manager, {
      expectedVersion: 3,
      category: 'lunch_boxes',
    });
    expect(back.json()).toMatchObject({ code: 'UNKNOWN_EXPENSE_CATEGORY' });
  });

  test('a stale version is 409; duplicate or bad keys are 400; the list is not under /v1/settings', async () => {
    const stale = await put(manager, { expectedVersion: 99, categories: [entry('gas', 'แก๊ส')] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    const version = (await read()).version;
    for (const categories of [[entry('gas', 'a'), entry('gas', 'b')], [entry('Gas', 'a')], []]) {
      expect((await put(manager, { expectedVersion: version, categories })).statusCode).toBe(400);
    }
    const cashier = await staff('cashier');
    expect((await call('GET', '/v1/settings/expense-categories', cashier)).statusCode).toBe(404);
  });
});

describe('platform commission setting', () => {
  const URL = '/v1/settings/platform-commission';
  async function ownerStepped() {
    h.clock.advanceSeconds(90);
    return h.steppedUpOwner(owner);
  }

  test('no built-in rate: the owner sees both unset at version 0', async () => {
    await h.client.query("delete from settings where key = 'platform_commission'");
    h.clock.advanceSeconds(90);
    const res = await call('GET', URL, await h.ownerSession(owner));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      value: { grabRateBp: null, linemanRateBp: null },
      version: 0,
      rev: 0,
      updatedAt: null,
    });
  });

  test('the rates are readable by the owner only: manager, cashier and kitchen get 403, no session 401', async () => {
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const res = await call('GET', URL, await staff(role));
      expect(res.statusCode, role).toBe(403);
      expect(JSON.stringify(res.json()), role).not.toContain('RateBp');
    }
    expect((await call('GET', URL, undefined)).statusCode).toBe(401);
  });

  test('the other settings stay readable by cashiers (the QR needs the PromptPay ID)', async () => {
    const cashier = await staff('cashier');
    expect((await call('GET', '/v1/settings/shop', cashier)).statusCode).toBe(200);
  });

  test('owner only, and only after a fresh step-up', async () => {
    const body = { expectedVersion: 0, grabRateBp: 900 };
    const denied = await call('PATCH', URL, manager, body);
    expect(denied.statusCode).toBe(403);
    h.clock.advanceSeconds(90);
    const signedInOnly = await h.ownerSession(owner);
    const noStepUp = await call('PATCH', URL, signedInOnly, body);
    expect(noStepUp.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  test('the owner sets a rate: audited, owner alerted, nothing broadcast; a rate can be cleared', async () => {
    const token = await ownerStepped();
    const alertsBefore = h.alerts.length;
    const eventsBefore = h.events.length;
    const res = await call('PATCH', URL, token, { expectedVersion: 0, grabRateBp: 900 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 1,
      value: { grabRateBp: 900, linemanRateBp: null },
    });
    const audit = (await h.auditRows('platform_commission')).find(
      (a) => a.action === 'settings.platform_commission_change',
    );
    expect(audit).toMatchObject({
      actorId: owner.staffId,
      before: { grabRateBp: null },
      after: { grabRateBp: 900 },
    });
    expect(h.alerts.slice(alertsBefore)).toEqual([
      expect.objectContaining({ kind: 'settings.platform_commission_changed', severity: 'warn' }),
    ]);
    expect(h.events.slice(eventsBefore).some((e) => e.type === 'settings.updated')).toBe(false);

    const cleared = await call('PATCH', URL, token, { expectedVersion: 1, grabRateBp: null });
    expect(cleared.json()).toMatchObject({ value: { grabRateBp: null } });
  });

  test('out-of-range or fractional rates are 400', async () => {
    const token = await ownerStepped();
    for (const grabRateBp of [-1, 10001, 9.5]) {
      const res = await call('PATCH', URL, token, { expectedVersion: 2, grabRateBp });
      expect(res.statusCode).toBe(400);
    }
  });
});
