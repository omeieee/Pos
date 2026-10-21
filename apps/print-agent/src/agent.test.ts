import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INIT_PRINTER } from '@sds/escpos';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentDeps, BACKOFF_MAX_MS, backoffMs, createAgent } from './agent.ts';
import { createPrintApi } from './api.ts';
import { type AgentConfig, loadConfig } from './config.ts';
import type { LogFields } from './log.ts';
import { sendToPrinter } from './printer.ts';
import { openPrintedStore } from './store.ts';
import {
  closedPort,
  type FakeApi,
  type FakePrinter,
  makeJob,
  startFakeApi,
  startFakePrinter,
} from './test-support.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

interface Rig {
  api: FakeApi;
  printer: FakePrinter;
  config: AgentConfig;
  logs: Array<{ level: string; event: string; fields: LogFields }>;
  sleeps: number[];
  agent: ReturnType<typeof createAgent>;
  storeFile: string;
}

async function rig(
  options: {
    printerPort?: number;
    send?: typeof sendToPrinter;
    render?: AgentDeps['render'];
    storeFile?: string;
  } = {},
): Promise<Rig> {
  const api = await startFakeApi();
  const printer = await startFakePrinter();
  cleanup.push(api.close, printer.close);
  const storeFile = options.storeFile ?? join(mkdtempSync(join(tmpdir(), 'sds-agent-')), 'p.json');
  const config = loadConfig({
    PRINTER_HOST: '127.0.0.1',
    PRINTER_PORT: String(options.printerPort ?? printer.port),
    PRINTER_TIMEOUT_MS: '3000',
    PRINT_API_URL: api.baseUrl,
    PRINT_DEVICE_TOKEN: api.token,
  });
  const logs: Rig['logs'] = [];
  const sleeps: number[] = [];
  const agent = createAgent({
    config,
    api: createPrintApi({ baseUrl: api.baseUrl, token: api.token, timeoutMs: 2_000 }),
    store: openPrintedStore(storeFile),
    log: (level, event, fields = {}) => logs.push({ level, event, fields }),
    send: options.send ?? sendToPrinter,
    ...(options.render ? { render: options.render } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { api, printer, config, logs, sleeps, agent, storeFile };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('one round', () => {
  it('claims, prints the raster ticket, and acks printed with the lease token', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job);

    expect(await r.agent.runOnce()).toBe('printed');
    await settle();

    expect(r.printer.received).toHaveLength(1);
    const bytes = r.printer.received[0] ?? new Uint8Array();
    expect([...bytes.slice(0, INIT_PRINTER.length + 4)]).toEqual([
      ...INIT_PRINTER,
      0x1d,
      0x76,
      0x30,
      0x00,
    ]);
    expect(r.api.acks).toEqual([
      { jobId: job.id, body: { leaseToken: job.leaseToken, result: 'printed' } },
    ]);
    // The claim sends an empty JSON object and the device token.
    const claim = r.api.calls.find((call) => call.path === '/v1/print/claim');
    expect(claim?.body).toEqual({});
    expect(claim?.token).toBe(r.api.token);
  });

  it('reports idle when nothing waits', async () => {
    const r = await rig();
    expect(await r.agent.runOnce()).toBe('idle');
    expect(r.printer.received).toHaveLength(0);
    expect(r.api.acks).toHaveLength(0);
  });

  it('acks failed PRINTER_OFFLINE when the printer is unreachable, and does not remember the job', async () => {
    const r = await rig({ printerPort: await closedPort() });
    const job = makeJob();
    r.api.queue.push(job);

    expect(await r.agent.runOnce()).toBe('failed');
    expect(r.api.acks).toEqual([
      {
        jobId: job.id,
        body: { leaseToken: job.leaseToken, result: 'failed', errorCode: 'PRINTER_OFFLINE' },
      },
    ]);
    // Offered again later, it prints (nothing was remembered as printed).
    expect(openPrintedStore(r.storeFile).has(job.id)).toBe(false);
  });

  it('acks failed RENDER_FAILED when the ticket cannot be drawn', async () => {
    const r = await rig({
      render: () => {
        throw new Error('boom');
      },
    });
    const job = makeJob();
    r.api.queue.push(job);
    expect(await r.agent.runOnce()).toBe('failed');
    expect(r.api.acks[0]?.body).toEqual({
      leaseToken: job.leaseToken,
      result: 'failed',
      errorCode: 'RENDER_FAILED',
    });
    expect(r.printer.received).toHaveLength(0);
  });

  it('acks failed OTHER for an error that is not a printer error', async () => {
    const r = await rig({
      send: () => Promise.reject(new Error('weird')),
    });
    r.api.queue.push(makeJob());
    await r.agent.runOnce();
    expect(r.api.acks[0]?.body).toMatchObject({ result: 'failed', errorCode: 'OTHER' });
  });
});

describe('a lost ack never prints a ticket twice', () => {
  it('keeps the ack owed when the API fails after the print, then settles it first next round', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job);
    // The claim works; the ack that follows the print gets a 500.
    r.api.failAcks.push(500);

    expect(await r.agent.runOnce()).toBe('printed');
    await settle();
    expect(r.printer.received).toHaveLength(1);
    expect(r.api.acks).toHaveLength(0);
    expect(openPrintedStore(r.storeFile).owed()).toHaveLength(1);

    // Next round: the owed ack goes out before anything else.
    expect(await r.agent.runOnce()).toBe('idle');
    expect(r.api.acks.map((ack) => ack.jobId)).toEqual([job.id]);
    expect(openPrintedStore(r.storeFile).owed()).toEqual([]);
  });

  it('skips a job it printed before (server offered it again) and just acks it', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job, { ...job, attempt: 2, leaseToken: randomUUID() });

    expect(await r.agent.runOnce()).toBe('printed');
    // Pretend the first ack never counted: the server offers the same job again.
    expect(await r.agent.runOnce()).toBe('duplicate');
    await settle();

    expect(r.printer.received).toHaveLength(1);
    expect(r.api.acks.filter((ack) => ack.jobId === job.id).length).toBeGreaterThanOrEqual(2);
    expect(r.logs.some((log) => log.event === 'job.duplicate_skipped')).toBe(true);
  });

  it('remembers across a restart (a new agent on the same file)', async () => {
    const r1 = await rig();
    const job = makeJob();
    r1.api.queue.push(job);
    await r1.agent.runOnce();

    const r2 = await rig({ storeFile: r1.storeFile });
    r2.api.queue.push({ ...job, attempt: 2 });
    expect(await r2.agent.runOnce()).toBe('duplicate');
    expect(r2.printer.received).toHaveLength(0);
  });

  it('drops an owed ack the server rejects (job gone) instead of retrying forever', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job);
    r.api.failAcks.push(500, 404); // the ack after the print, then its retry (job gone)
    await r.agent.runOnce(); // printed, ack pending
    expect(openPrintedStore(r.storeFile).owed()).toHaveLength(1);
    await r.agent.runOnce(); // owed ack -> 404 -> dropped, claim idle
    expect(openPrintedStore(r.storeFile).owed()).toEqual([]);
  });
});

describe('the loop', () => {
  it('backs off exponentially while the API is down and recovers without losing the job', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job);
    r.api.failNext.push(503, 503, 503);
    // Stop after the job is printed.
    let rounds = 0;
    const agent = createAgent({
      config: r.config,
      api: createPrintApi({ baseUrl: r.api.baseUrl, token: r.api.token, timeoutMs: 2_000 }),
      store: openPrintedStore(r.storeFile),
      log: (level, event, fields = {}) => r.logs.push({ level, event, fields }),
      send: sendToPrinter,
      sleep: async (ms) => {
        r.sleeps.push(ms);
        rounds += 1;
        if (r.api.acks.length > 0) agent.stop();
      },
      random: () => 0.5,
    });
    await agent.run();
    expect(r.sleeps.slice(0, 3)).toEqual([2_000, 4_000, 8_000]);
    expect(r.api.acks.map((ack) => ack.jobId)).toEqual([job.id]);
    expect(r.printer.received).toHaveLength(1);
    expect(rounds).toBeGreaterThanOrEqual(3);
    // One error line when it starts failing, one when it recovers; not one per retry.
    expect(r.logs.filter((log) => log.event === 'api.unavailable')).toHaveLength(1);
    expect(r.logs.some((log) => log.event === 'api.recovered')).toBe(true);
  });

  it('caps the back-off at 60 seconds', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(5)).toBe(32_000);
    expect(backoffMs(6)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(40)).toBe(BACKOFF_MAX_MS);
  });

  it('waits the maximum when the token is refused, and keeps trying', async () => {
    const r = await rig();
    const agent = createAgent({
      config: r.config,
      api: createPrintApi({
        baseUrl: r.api.baseUrl,
        token: 'wrong-token-0123456789',
        timeoutMs: 2_000,
      }),
      store: openPrintedStore(r.storeFile),
      log: (level, event, fields = {}) => r.logs.push({ level, event, fields }),
      send: sendToPrinter,
      sleep: async (ms) => {
        r.sleeps.push(ms);
        if (r.sleeps.length === 2) agent.stop();
      },
    });
    await agent.run();
    expect(r.sleeps).toEqual([BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(r.logs.filter((log) => log.event === 'api.unavailable')).toHaveLength(1);
    expect(r.logs.find((log) => log.event === 'api.unavailable')?.fields).toMatchObject({
      reason: 'auth',
      httpStatus: 401,
    });
  });

  it('on stop, finishes the job being printed and acks it before returning', async () => {
    const r = await rig();
    const job = makeJob();
    r.api.queue.push(job);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sending: () => void = () => {};
    const sendingStarted = new Promise<void>((resolve) => {
      sending = resolve;
    });
    const agent = createAgent({
      config: r.config,
      api: createPrintApi({ baseUrl: r.api.baseUrl, token: r.api.token, timeoutMs: 2_000 }),
      store: openPrintedStore(r.storeFile),
      log: () => {},
      send: async (bytes, target) => {
        sending();
        await gate; // the printer is slow
        await sendToPrinter(bytes, target);
      },
    });
    const finished = agent.run();
    await sendingStarted;
    agent.stop(); // Ctrl+C while the ticket is going out
    release();
    await finished;

    expect(r.printer.received).toHaveLength(1);
    expect(r.api.acks.map((ack) => [ack.jobId, ack.body.result])).toEqual([[job.id, 'printed']]);
  });

  it('keeps draining a busy queue without waiting between jobs', async () => {
    const r = await rig();
    r.api.queue.push(makeJob(), makeJob(), makeJob());
    const agent = createAgent({
      config: r.config,
      api: createPrintApi({ baseUrl: r.api.baseUrl, token: r.api.token, timeoutMs: 2_000 }),
      store: openPrintedStore(r.storeFile),
      log: () => {},
      send: sendToPrinter,
      sleep: async (ms) => {
        r.sleeps.push(ms);
        agent.stop(); // the first wait happens only when the queue is empty
      },
    });
    await agent.run();
    expect(r.api.acks).toHaveLength(3);
    expect(r.sleeps).toEqual([r.config.pollIntervalMs]);
  });
});

describe('logs', () => {
  it('hold ids and codes only: no token, no ticket text', async () => {
    const r = await rig({ printerPort: await closedPort() });
    r.api.queue.push(makeJob());
    r.api.queue.push(makeJob());
    await r.agent.runOnce();
    await r.agent.runOnce();
    const text = JSON.stringify(r.logs);
    expect(text).not.toContain(r.api.token);
    for (const secret of ['สมชาย', 'ก๋วยเตี๋ยว', 'อาคาร', 'รปภ', 'L-012']) {
      expect(text).not.toContain(secret);
    }
    expect(r.logs.length).toBeGreaterThan(0);
  });
});
