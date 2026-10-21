import type { PrintJobDto } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { uuid } from '../../test-support/frames.ts';
import { createPrintStore, type PrintDeps } from './print-store.ts';

const ORDER = uuid(900);
const OTHER = uuid(901);

const job = (seq: number, over: Partial<PrintJobDto> = {}): PrintJobDto => ({
  id: uuid(500 + seq),
  orderId: ORDER,
  orderNo: 'S-013',
  kind: 'reprint',
  seq,
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2030-10-15T05:00:00.000Z',
  printedAt: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: { online?: boolean } = {}) {
  let online = options.online ?? true;
  let n = 0;
  const api = {
    print: {
      reprint: vi.fn<PrintDeps['api']['print']['reprint']>(async () => ({
        job: job(1),
        replay: false,
      })),
      jobs: vi.fn<PrintDeps['api']['print']['jobs']>(async () => ({ jobs: [job(1)] })),
    },
  };
  const store = createPrintStore({
    api,
    lifecycle: { isOnline: () => online },
    newId: () => uuid(700 + ++n),
  });
  return {
    store,
    api,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe('reprint', () => {
  test('sends one request with a fresh key and shows the server’s copy number', async () => {
    const { store, api } = setup();
    api.print.reprint.mockResolvedValueOnce({ job: job(3), replay: false });
    const outcome = await store.reprint(ORDER);
    expect(outcome).toEqual({ ok: true, seq: 3 });
    expect(api.print.reprint).toHaveBeenCalledWith(ORDER, uuid(701));
    expect(store.getState().results[ORDER]).toEqual({ kind: 'done', seq: 3 });
    expect(store.getState().pending).toEqual([]);
  });

  test('a second tap while the first is on its way sends nothing', async () => {
    const { store, api } = setup();
    const first = deferred<{ job: PrintJobDto; replay: boolean }>();
    api.print.reprint.mockReturnValueOnce(first.promise);
    const one = store.reprint(ORDER);
    const two = await store.reprint(ORDER);
    expect(two).toEqual({ ok: false, reason: 'busy' });
    expect(api.print.reprint).toHaveBeenCalledTimes(1);
    first.resolve({ job: job(1), replay: false });
    await one;
    expect(store.getState().pending).toEqual([]);
  });

  test('another order is not held up by it', async () => {
    const { store, api } = setup();
    const first = deferred<{ job: PrintJobDto; replay: boolean }>();
    api.print.reprint.mockReturnValueOnce(first.promise);
    const one = store.reprint(ORDER);
    expect((await store.reprint(OTHER)).ok).toBe(true);
    first.resolve({ job: job(1), replay: false });
    await one;
  });

  test('after a done reprint the next tap is a new request with a new key', async () => {
    const { store, api } = setup();
    await store.reprint(ORDER);
    await store.reprint(ORDER);
    expect(api.print.reprint.mock.calls.map((call) => call[1])).toEqual([uuid(701), uuid(702)]);
  });

  test('a lost answer keeps the key, so the retry cannot print twice', async () => {
    const { store, api } = setup();
    api.print.reprint.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    const lost = await store.reprint(ORDER);
    expect(lost).toMatchObject({ ok: false, reason: 'error' });
    await store.reprint(ORDER);
    expect(api.print.reprint.mock.calls.map((call) => call[1])).toEqual([uuid(701), uuid(701)]);
  });

  test('PRINTING_OFF is shown as the server’s refusal and drops the key', async () => {
    const { store, api } = setup();
    api.print.reprint.mockRejectedValueOnce(new ApiClientError('PRINTING_OFF', { status: 409 }));
    await store.reprint(ORDER);
    const result = store.getState().results[ORDER];
    expect(result).toMatchObject({ kind: 'error', error: { code: 'PRINTING_OFF' } });
    await store.reprint(ORDER);
    expect(api.print.reprint.mock.calls.map((call) => call[1])).toEqual([uuid(701), uuid(702)]);
    // The next try starts clean: the old refusal is gone while it is on its way.
    expect(store.getState().results[ORDER]).toEqual({ kind: 'done', seq: 1 });
  });

  test('offline sends nothing and says so', async () => {
    const { store, api } = setup({ online: false });
    const outcome = await store.reprint(ORDER);
    expect(outcome).toEqual({ ok: false, reason: 'offline' });
    expect(api.print.reprint).not.toHaveBeenCalled();
    expect(store.getState().results[ORDER]).toEqual({ kind: 'offline' });
  });

  test('dismiss forgets one order’s outcome', async () => {
    const { store } = setup();
    await store.reprint(ORDER);
    store.dismiss(ORDER);
    expect(store.getState().results).toEqual({});
  });

  test('an answer that arrives after sign-out changes nothing', async () => {
    const { store, api } = setup();
    const late = deferred<{ job: PrintJobDto; replay: boolean }>();
    api.print.reprint.mockReturnValueOnce(late.promise);
    const sent = store.reprint(ORDER);
    store.reset();
    late.resolve({ job: job(1), replay: false });
    expect(await sent).toEqual({ ok: false, reason: 'stale' });
    expect(store.getState().results).toEqual({});
    expect(store.getState().pending).toEqual([]);
  });
});

describe('recent jobs', () => {
  test('reads once for callers at the same time and keeps the list', async () => {
    const { store, api } = setup();
    await Promise.all([store.loadJobs(), store.loadJobs()]);
    expect(api.print.jobs).toHaveBeenCalledTimes(1);
    expect(store.getState().jobs).toMatchObject({ status: 'ready', jobs: [{ seq: 1 }] });
  });

  test('a failed first read is an error; a failed later read keeps what is shown', async () => {
    const { store, api } = setup();
    api.print.jobs.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.loadJobs();
    expect(store.getState().jobs.status).toBe('error');
    await store.loadJobs();
    expect(store.getState().jobs.status).toBe('ready');
    api.print.jobs.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await store.loadJobs();
    expect(store.getState().jobs).toMatchObject({ status: 'ready', jobs: [{ seq: 1 }] });
  });

  test('sign-out empties the list', async () => {
    const { store } = setup();
    await store.loadJobs();
    store.reset();
    expect(store.getState().jobs).toEqual({ status: 'idle', jobs: [] });
  });
});
