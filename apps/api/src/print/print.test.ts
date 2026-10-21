import {
  type ClaimPrintJobResponse,
  type OrderDto,
  orderDtoSchema,
  PRINT_MAX_ATTEMPTS,
  type PrintJobDto,
  printJobDtoSchema,
} from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';

let h: Harness;
let menu: Menu;
let ipad: { id: string; token: string };
let printer: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', string>;

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  ipad = await h.newDevice('ipad');
  printer = await h.newDevice('print_agent');
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    const member = await h.newStaff(role, '4821');
    staff[role] = await h.pinSession(ipad.token, member.id, member.pin);
  }
}, 60_000);
afterAll(async () => {
  await h.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const agent = (token = printer.token) => ({ 'x-device-token': token });

// ---------- helpers ----------

async function setPrinting(enabled: boolean) {
  const read = await h.app.inject({
    method: 'GET',
    url: '/v1/settings/printing',
    headers: bearer(staff.manager),
  });
  const version = (read.json() as { version: number }).version;
  const res = await h.app.inject({
    method: 'PATCH',
    url: '/v1/settings/printing',
    headers: bearer(staff.manager),
    payload: { expectedVersion: version, enabled },
  });
  expect(res.statusCode).toBe(200);
}

const orderBody = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  channel: 'storefront',
  fulfillment: 'entrance_delivery',
  deliveryBuilding: 'B1',
  recipientName: 'Test Recipient',
  items: [{ menuItemId: menu.noodles, qty: 2, modifierOptionIds: [menu.thin], note: 'no veg' }],
  ...over,
});

async function place(over: Record<string, unknown> = {}): Promise<OrderDto> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: bearer(staff.cashier),
    payload: orderBody(over),
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  await h.settle();
  return orderDtoSchema.parse(res.json());
}

async function jobsOf(orderId: string) {
  const res = await h.client.query<{
    id: string;
    kind: string;
    seq: number;
    status: string;
    attempts: number;
    last_error: string | null;
  }>(
    'select id, kind, seq, status, attempts, last_error from print_jobs where order_id = $1 order by seq',
    [orderId],
  );
  return res.rows;
}

const claim = (headers: Record<string, string> = agent()) =>
  h.app.inject({ method: 'POST', url: '/v1/print/claim', headers, payload: {} });

async function claimed(): Promise<NonNullable<ClaimPrintJobResponse['job']>> {
  const res = await claim();
  expect(res.statusCode).toBe(200);
  const body = res.json() as ClaimPrintJobResponse;
  if (!body.job) throw new Error('nothing to claim');
  return body.job;
}

const ack = (
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = agent(),
) => h.app.inject({ method: 'POST', url: `/v1/print/jobs/${id}/ack`, headers, payload: body });

const reprint = (
  orderId: string,
  token: string,
  clientRequestId = crypto.randomUUID(),
  extra: Record<string, string> = {},
) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/reprint`,
    headers: { ...bearer(token), ...extra },
    payload: { clientRequestId },
  });

/** Moves every job that is still waiting out of the way, so each test starts with an empty queue. */
beforeEach(async () => {
  await h.client.query(
    "update print_jobs set status = 'printed', printed_at = now(), lease_token = null, lease_until = null where status in ('pending', 'claimed')",
  );
});

// ---------- the switch ----------

describe('the printing setting', () => {
  test('is off until it is saved; a manager turns it on, a cashier can read but not change it', async () => {
    await h.client.query("delete from settings where key = 'printing'");
    const before = await h.app.inject({
      method: 'GET',
      url: '/v1/settings/printing',
      headers: bearer(staff.cashier),
    });
    expect(before.json()).toMatchObject({ value: { enabled: false }, version: 0 });

    const denied = await h.app.inject({
      method: 'PATCH',
      url: '/v1/settings/printing',
      headers: bearer(staff.cashier),
      payload: { expectedVersion: 0, enabled: true },
    });
    expect(denied.statusCode).toBe(403);

    const kitchen = await h.app.inject({
      method: 'GET',
      url: '/v1/settings/printing',
      headers: bearer(staff.kitchen),
    });
    expect(kitchen.statusCode).toBe(403);

    const on = await h.app.inject({
      method: 'PATCH',
      url: '/v1/settings/printing',
      headers: bearer(staff.manager),
      payload: { expectedVersion: 0, enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ value: { enabled: true }, version: 1 });
    expect((await h.auditRows('printing')).map((a) => a.action)).toContain('settings.update');

    const stale = await h.app.inject({
      method: 'PATCH',
      url: '/v1/settings/printing',
      headers: bearer(staff.manager),
      payload: { expectedVersion: 0, enabled: false },
    });
    expect(stale.statusCode).toBe(409);
  });
});

// ---------- enqueue ----------

describe('enqueue', () => {
  test('while printing is off an order gets no job', async () => {
    await setPrinting(false);
    const order = await place();
    expect(await jobsOf(order.id)).toEqual([]);
  });

  test('while printing is on a counter order gets exactly one pending kitchen job', async () => {
    await setPrinting(true);
    const order = await place();
    const jobs = await jobsOf(order.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'kitchen', seq: 0, status: 'pending', attempts: 0 });
  });

  test('the same event twice, or a later change to the order, does not add a job', async () => {
    await setPrinting(true);
    const order = await place();
    h.bus.publish({ type: 'order.sent_to_kitchen', orderId: order.id });
    h.bus.publish({ type: 'order.sent_to_kitchen', orderId: order.id });
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: bearer(staff.cashier),
      payload: { expectedVersion: order.version, note: 'more chilli' },
    });
    expect(patched.statusCode).toBe(200);
    await h.settle();
    expect(await jobsOf(order.id)).toHaveLength(1);
  });

  test('a LINE order prints when staff accept it, not when it arrives', async () => {
    await setPrinting(true);
    const order = await place({ channel: 'line' });
    expect(order.status).toBe('new');
    expect(await jobsOf(order.id)).toEqual([]);
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/transition`,
      headers: bearer(staff.kitchen),
      payload: { to: 'preparing' },
    });
    expect(accepted.statusCode).toBe(200);
    await h.settle();
    expect(await jobsOf(order.id)).toHaveLength(1);
  });

  test('an order accepted while printing is off is skipped even after printing is turned on', async () => {
    await setPrinting(false);
    const order = await place();
    await setPrinting(true);
    // Later changes to the order are not a new trip to the kitchen.
    await h.app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: bearer(staff.cashier),
      payload: { expectedVersion: order.version, note: 'x' },
    });
    await h.settle();
    expect(await jobsOf(order.id)).toEqual([]);
  });

  test('a queue that cannot be written never breaks the order', async () => {
    await setPrinting(true);
    await h.client.query('alter table print_jobs rename to print_jobs_away');
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: bearer(staff.cashier),
        payload: orderBody(),
      });
      expect(res.statusCode).toBe(201);
      await h.settle();
    } finally {
      await h.client.query('alter table print_jobs_away rename to print_jobs');
    }
  });
});

// ---------- the print program ----------

describe('who may claim', () => {
  test('only a registered print_agent device', async () => {
    expect((await claim({})).statusCode).toBe(401);
    expect((await claim(agent('not-a-real-token-at-all-0000'))).statusCode).toBe(401);
    // A staff session alone has no device token for this route.
    expect(
      (await claim({ ...bearer(staff.manager), 'x-test-no-device-autofill': '1' })).statusCode,
    ).toBe(401);
    // A tablet's token is a device, but not a printer.
    expect((await claim(agent(ipad.token))).statusCode).toBe(403);
    const other = await h.newDevice('print_agent');
    expect((await claim(agent(other.token))).statusCode).toBe(200);
    await h.revokeDevice(other.id);
    expect((await claim(agent(other.token))).statusCode).toBe(401);
  });

  test('a print_agent token is not a staff sign-in: it cannot read orders or settings', async () => {
    for (const url of ['/v1/orders', '/v1/settings/printing', '/v1/print/jobs']) {
      const res = await h.app.inject({ method: 'GET', url, headers: agent() });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('claim, lease and ack', () => {
  test('answers null when nothing waits', async () => {
    expect((await claim()).json()).toEqual({ job: null });
  });

  test('hands out the ticket, leases the job and counts the attempt', async () => {
    await setPrinting(true);
    const order = await place();
    const job = await claimed();
    expect(job).toMatchObject({ kind: 'kitchen', seq: 0, attempt: 1 });
    expect(job.ticket).toMatchObject({
      orderNo: order.orderNo,
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      who: 'Test Recipient',
      building: 'B1',
      reprint: false,
    });
    expect(job.ticket.lines).toEqual([
      { qty: 2, nameTh: 'ก๋วยเตี๋ยวต้มยำ', modifiers: ['เส้นเล็ก'], note: 'no veg' },
    ]);
    expect(new Date(job.leaseUntil).getTime()).toBe(h.clock.now().getTime() + 30_000);
    const [row] = await jobsOf(order.id);
    expect(row).toMatchObject({ status: 'claimed', attempts: 1 });
    // A leased job is not handed out twice.
    expect((await claim()).json()).toEqual({ job: null });
  });

  test('the oldest waiting job goes first', async () => {
    await setPrinting(true);
    const first = await place();
    h.clock.advanceSeconds(1);
    await place();
    expect((await claimed()).ticket.orderNo).toBe(first.orderNo);
  });

  test('a job is printed only by an ack, and the ack can be repeated', async () => {
    await setPrinting(true);
    const order = await place();
    const job = await claimed();
    const done = await ack(job.id, { leaseToken: job.leaseToken, result: 'printed' });
    expect(done.statusCode).toBe(200);
    expect(printJobDtoSchema.parse(done.json())).toMatchObject({
      status: 'printed',
      orderNo: order.orderNo,
    });
    const again = await ack(job.id, { leaseToken: job.leaseToken, result: 'printed' });
    expect(again.statusCode).toBe(200);
    expect(await jobsOf(order.id)).toHaveLength(1);
    expect((await claim()).json()).toEqual({ job: null });
  });

  test('an expired lease is claimed again with a new lease; the old holder cannot fail it but can still say it printed', async () => {
    await setPrinting(true);
    const order = await place();
    const first = await claimed();
    h.clock.advanceSeconds(29);
    expect((await claim()).json()).toEqual({ job: null });
    h.clock.advanceSeconds(2);
    const second = await claimed();
    expect(second.id).toBe(first.id);
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const lost = await ack(first.id, {
      leaseToken: first.leaseToken,
      result: 'failed',
      errorCode: 'TIMEOUT',
    });
    expect(lost.statusCode).toBe(409);
    expect(lost.json()).toMatchObject({ code: 'LEASE_LOST' });

    // The first holder did print: the job is printed, once, and the second holder's ack is a no-op.
    expect(
      (await ack(first.id, { leaseToken: first.leaseToken, result: 'printed' })).statusCode,
    ).toBe(200);
    expect(
      (await ack(second.id, { leaseToken: second.leaseToken, result: 'printed' })).statusCode,
    ).toBe(200);
    expect((await jobsOf(order.id))[0]?.status).toBe('printed');
    expect((await claim()).json()).toEqual({ job: null });
  });

  test('a failed ack retries after a delay, then fails for good and alerts staff', async () => {
    await setPrinting(true);
    const order = await place();
    const alertsBefore = h.alerts.filter((a) => a.kind === 'print.job_failed').length;
    for (let attempt = 1; attempt <= PRINT_MAX_ATTEMPTS; attempt++) {
      const job = await claimed();
      expect(job.attempt).toBe(attempt);
      const res = await ack(job.id, {
        leaseToken: job.leaseToken,
        result: 'failed',
        errorCode: 'OUT_OF_PAPER',
      });
      expect(res.statusCode).toBe(200);
      const dto = printJobDtoSchema.parse(res.json());
      if (attempt < PRINT_MAX_ATTEMPTS) {
        expect(dto).toMatchObject({ status: 'pending', lastError: 'OUT_OF_PAPER' });
        // Waits out its back-off before it can be claimed again.
        expect((await claim()).json()).toEqual({ job: null });
        h.clock.advanceSeconds(200);
      } else {
        expect(dto).toMatchObject({
          status: 'failed',
          attempts: attempt,
          lastError: 'OUT_OF_PAPER',
        });
      }
    }
    h.clock.advanceSeconds(1000);
    expect((await claim()).json()).toEqual({ job: null });
    expect((await jobsOf(order.id))[0]?.status).toBe('failed');
    const failures = h.alerts.filter((a) => a.kind === 'print.job_failed');
    expect(failures).toHaveLength(alertsBefore + 1);
    expect(failures.at(-1)).toMatchObject({
      severity: 'warn',
      orderNo: order.orderNo,
      subject: { orderId: order.id },
      deviceId: printer.id,
    });
  });

  test('a job whose lease keeps running out is failed after the last attempt, with an alert', async () => {
    await setPrinting(true);
    const order = await place();
    const alertsBefore = h.alerts.filter((a) => a.kind === 'print.job_failed').length;
    for (let attempt = 1; attempt <= PRINT_MAX_ATTEMPTS; attempt++) {
      expect((await claimed()).attempt).toBe(attempt);
      h.clock.advanceSeconds(31);
    }
    // The program never answered. The next claim finishes the job instead of handing it out again.
    expect((await claim()).json()).toEqual({ job: null });
    expect(await jobsOf(order.id)).toMatchObject([
      { status: 'failed', last_error: 'LEASE_EXPIRED' },
    ]);
    expect(h.alerts.filter((a) => a.kind === 'print.job_failed')).toHaveLength(alertsBefore + 1);
  });

  test('a failed ack must carry the lease, and an error must be a known code', async () => {
    await setPrinting(true);
    await place();
    const job = await claimed();
    const wrongToken = await ack(job.id, {
      leaseToken: crypto.randomUUID(),
      result: 'failed',
      errorCode: 'TIMEOUT',
    });
    expect(wrongToken.statusCode).toBe(409);
    for (const body of [
      { leaseToken: job.leaseToken, result: 'failed' },
      {
        leaseToken: job.leaseToken,
        result: 'failed',
        errorCode: 'the printer at 10.0.0.5 said no',
      },
      { result: 'printed' },
      { leaseToken: job.leaseToken, result: 'maybe' },
    ]) {
      expect((await ack(job.id, body)).statusCode).toBe(400);
    }
    expect(
      (await ack(crypto.randomUUID(), { leaseToken: job.leaseToken, result: 'printed' }))
        .statusCode,
    ).toBe(404);
    // Only the print program acks.
    expect(
      (
        await ack(
          job.id,
          { leaseToken: job.leaseToken, result: 'printed' },
          { ...bearer(staff.manager), 'x-test-no-device-autofill': '1' },
        )
      ).statusCode,
    ).toBe(401);
  });
});

// ---------- privacy ----------

describe('the ticket', () => {
  test('never holds a phone number, a customer id or money, even when the notes do', async () => {
    await setPrinting(true);
    const order = await place({ deliveryNote: 'call 081-234-5678 at the gate' });
    await h.client.query(
      "update orders set member_phone = '0899999999', member_full_name = 'Somchai Jaidee', member_nickname = null, recipient_name = 'Khun A', note = 'tel 0812345678' where id = $1",
      [order.id],
    );
    const job = await claimed();
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/\d{9}/);
    expect(text).not.toContain('081-234');
    expect(text).not.toContain('0899999999');
    expect(text).not.toContain('Somchai');
    expect(text).not.toContain('customerId');
    expect(text).not.toMatch(/atang|total|price/i);
    expect(job.ticket.who).toBe('Khun A');
    expect(job.ticket.deliveryNote).toContain('call');
    expect(job.ticket.deliveryNote).not.toMatch(/\d{4}/);
  });

  test('a removed order line is not on it', async () => {
    await setPrinting(true);
    const order = await place({
      items: [
        { menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] },
        { menuItemId: menu.water, qty: 3 },
      ],
    });
    await h.client.query(
      'update order_items set removed_at = now() where order_id = $1 and qty = 3',
      [order.id],
    );
    expect((await claimed()).ticket.lines).toHaveLength(1);
  });
});

// ---------- reprint ----------

describe('reprint', () => {
  test('each request makes exactly one new job; a retry of the same request makes none', async () => {
    await setPrinting(true);
    const order = await place();
    const requestId = crypto.randomUUID();
    const first = await reprint(order.id, staff.cashier, requestId, {
      'idempotency-key': requestId,
    });
    expect(first.statusCode).toBe(201);
    const dto = printJobDtoSchema.parse(first.json());
    expect(dto).toMatchObject({
      kind: 'reprint',
      seq: 1,
      status: 'pending',
      orderNo: order.orderNo,
    });

    const retry = await reprint(order.id, staff.cashier, requestId);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as PrintJobDto).id).toBe(dto.id);

    const second = await reprint(order.id, staff.manager);
    expect(second.statusCode).toBe(201);
    expect((second.json() as PrintJobDto).seq).toBe(2);

    expect((await jobsOf(order.id)).map((j) => `${j.kind}:${j.seq}`)).toEqual([
      'kitchen:0',
      'reprint:1',
      'reprint:2',
    ]);
    expect((await h.auditRows(dto.id)).map((a) => a.action)).toEqual(['print.reprint']);
  });

  test('two requests at the same moment each get their own sequence number', async () => {
    await setPrinting(true);
    const order = await place();
    const [a, b] = await Promise.all([
      reprint(order.id, staff.cashier),
      reprint(order.id, staff.manager),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect([(a.json() as PrintJobDto).seq, (b.json() as PrintJobDto).seq].sort()).toEqual([1, 2]);
  });

  test('the reprinted ticket says it is a reprint', async () => {
    await setPrinting(true);
    const order = await place();
    await reprint(order.id, staff.cashier);
    // The original comes first, then the copy.
    const original = await claimed();
    await ack(original.id, { leaseToken: original.leaseToken, result: 'printed' });
    const copy = await claimed();
    expect(copy).toMatchObject({ kind: 'reprint', seq: 1 });
    expect(copy.ticket).toMatchObject({ reprint: true, copy: 1, orderNo: order.orderNo });
  });

  test('an order that was skipped while printing was off can be printed once it is on', async () => {
    await setPrinting(false);
    const order = await place();
    await setPrinting(true);
    expect((await reprint(order.id, staff.cashier)).statusCode).toBe(201);
    expect((await claimed()).ticket.orderNo).toBe(order.orderNo);
  });

  test('refused while printing is off, but a retry of a request that was made earlier still answers', async () => {
    await setPrinting(true);
    const order = await place();
    const requestId = crypto.randomUUID();
    expect((await reprint(order.id, staff.cashier, requestId)).statusCode).toBe(201);
    await setPrinting(false);
    const off = await reprint(order.id, staff.cashier);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'PRINTING_OFF' });
    expect((await reprint(order.id, staff.cashier, requestId)).statusCode).toBe(200);
    expect(await jobsOf(order.id)).toHaveLength(2);
  });

  test('cashier, manager and owner may; the kitchen and the print program may not', async () => {
    await setPrinting(true);
    const order = await place();
    expect((await reprint(order.id, staff.kitchen)).statusCode).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/v1/orders/${order.id}/reprint`,
          headers: agent(),
          payload: { clientRequestId: crypto.randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/v1/orders/${order.id}/reprint`,
          payload: { clientRequestId: crypto.randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    expect((await reprint(order.id, staff.cashier)).statusCode).toBe(201);
    const owner = await h.newOwner();
    expect((await reprint(order.id, await h.ownerSession(owner))).statusCode).toBe(201);
  });

  test('bad requests: unknown order, a request id used for another order, a mismatched header, a bad body', async () => {
    await setPrinting(true);
    const a = await place();
    const b = await place();
    expect((await reprint(crypto.randomUUID(), staff.cashier)).statusCode).toBe(404);
    const requestId = crypto.randomUUID();
    expect((await reprint(a.id, staff.cashier, requestId)).statusCode).toBe(201);
    const reused = await reprint(b.id, staff.cashier, requestId);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(
      (
        await reprint(a.id, staff.cashier, crypto.randomUUID(), {
          'idempotency-key': crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    const bad = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${a.id}/reprint`,
      headers: bearer(staff.cashier),
      payload: { clientRequestId: 'nope', extra: 1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ---------- the list ----------

describe('GET /v1/print/jobs', () => {
  test('any signed-in staff, newest first, with order numbers and no ticket', async () => {
    await setPrinting(true);
    const order = await place();
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/print/jobs?limit=5',
      headers: bearer(staff.kitchen),
    });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: PrintJobDto[] };
    expect(jobs.length).toBeLessThanOrEqual(5);
    expect(jobs[0]).toMatchObject({ orderId: order.id, orderNo: order.orderNo, status: 'pending' });
    expect(Object.keys(jobs[0] ?? {})).not.toContain('ticket');
    expect(Object.keys(jobs[0] ?? {})).not.toContain('leaseToken');
    for (const job of jobs) printJobDtoSchema.parse(job);

    expect((await h.app.inject({ method: 'GET', url: '/v1/print/jobs' })).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/v1/print/jobs?limit=0',
          headers: bearer(staff.kitchen),
        })
      ).statusCode,
    ).toBe(400);
  });
});
