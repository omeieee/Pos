import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createLineRuntime } from '../line/runtime.ts';
import { createMemorySlipStore } from '../slips/store.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { JOBS, type JobDeps } from './jobs.ts';
import {
  PRINT_AGENT_SILENT_MINUTES,
  PRINT_AGENT_SILENT_REALERT_MINUTES,
  resetPrintAgentSilentState,
} from './print-agent-silent.ts';

let h: Harness;
let menu: Menu;
let manager: string;
let printer: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  const ipad = await h.newDevice('ipad');
  printer = await h.newDevice('print_agent');
  const member = await h.newStaff('manager', '4821');
  manager = await h.pinSession(ipad.token, member.id, member.pin);
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  h.alerts.length = 0;
  resetPrintAgentSilentState();
  await h.client.query(
    "update print_jobs set status = 'printed', printed_at = now(), lease_token = null, lease_until = null where status in ('pending', 'claimed')",
  );
});

const bearer = () => ({ authorization: `Bearer ${manager}` });

async function setPrinting(enabled: boolean) {
  const read = await h.app.inject({
    method: 'GET',
    url: '/v1/settings/printing',
    headers: bearer(),
  });
  const res = await h.app.inject({
    method: 'PATCH',
    url: '/v1/settings/printing',
    headers: bearer(),
    payload: { expectedVersion: (read.json() as { version: number }).version, enabled },
  });
  expect(res.statusCode).toBe(200);
}

async function place(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: bearer(),
    payload: {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
    },
  });
  expect(res.statusCode).toBe(201);
  await h.settle();
  return (res.json() as { id: string }).id;
}

const run = () => {
  const job = JOBS.find((j) => j.name === 'print-agent-silent-check');
  if (!job) throw new Error('no such job');
  const deps: JobDeps = {
    db: h.db,
    events: h.bus,
    now: h.clock.now,
    line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
    slips: createMemorySlipStore(),
  };
  return job.run(deps);
};
const silent = () => h.alerts.filter((a) => a.kind === 'print.agent_silent');
const agent = () => ({ 'x-device-token': printer.token });
const claim = () =>
  h.app.inject({ method: 'POST', url: '/v1/print/claim', headers: agent(), payload: {} });
const pastThreshold = () => h.clock.advanceSeconds(PRINT_AGENT_SILENT_MINUTES * 60 + 1);

describe('print-agent-silent-check', () => {
  test('is a five-field cron job', () => {
    const job = JOBS.find((j) => j.name === 'print-agent-silent-check');
    expect(job?.cron.trim().split(/\s+/)).toHaveLength(5);
  });

  test('a fresh waiting ticket raises nothing; one past the threshold raises one warn alert with no personal data', async () => {
    await setPrinting(true);
    await place();
    expect(await run()).toMatchObject({ waiting: 0, alerts: 0 });
    pastThreshold();
    expect(await run()).toMatchObject({ waiting: 1, alerts: 1 });
    expect(silent()).toHaveLength(1);
    expect(silent()[0]).toMatchObject({ severity: 'warn', staffId: null });
    expect(JSON.stringify(silent()[0])).not.toMatch(/Test Recipient|B1/);
  });

  test('does not repeat on the next runs, nor before the re-alert time', async () => {
    await setPrinting(true);
    await place();
    pastThreshold();
    await run();
    h.clock.advanceSeconds(120);
    expect((await run()).alerts).toBe(0);
    h.clock.advanceSeconds((PRINT_AGENT_SILENT_REALERT_MINUTES - 10) * 60);
    expect((await run()).alerts).toBe(0);
    expect(silent()).toHaveLength(1);
  });

  test('alerts again after the re-alert time while still silent', async () => {
    await setPrinting(true);
    await place();
    pastThreshold();
    await run();
    h.clock.advanceSeconds(PRINT_AGENT_SILENT_REALERT_MINUTES * 60);
    expect((await run()).alerts).toBe(1);
    expect(silent()).toHaveLength(2);
  });

  test('alerts again after the queue drained once', async () => {
    await setPrinting(true);
    await place();
    pastThreshold();
    await run();
    const body = (await claim()).json() as { job: { id: string; leaseToken: string } };
    await h.app.inject({
      method: 'POST',
      url: `/v1/print/jobs/${body.job.id}/ack`,
      headers: agent(),
      payload: { leaseToken: body.job.leaseToken, result: 'printed' },
    });
    expect((await run()).alerts).toBe(0); // drained: the memory of the alert is cleared
    await place();
    pastThreshold();
    expect((await run()).alerts).toBe(1);
    expect(silent()).toHaveLength(2);
  });

  test('a ticket the program has claimed is not silence', async () => {
    await setPrinting(true);
    await place();
    await claim();
    pastThreshold();
    expect((await run()).alerts).toBe(0);
  });

  test('no alert while printing is off', async () => {
    await setPrinting(true);
    await place();
    await setPrinting(false);
    pastThreshold();
    expect(await run()).toMatchObject({ alerts: 0 });
    expect(silent()).toHaveLength(0);
  });

  test('a waiting ticket of a cancelled order is not counted', async () => {
    await setPrinting(true);
    const id = await place();
    await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${id}/cancel`,
      headers: bearer(),
      payload: { reason: 'test' },
    });
    await h.settle();
    pastThreshold();
    expect(await run()).toMatchObject({ waiting: 0, alerts: 0 });
  });
});
