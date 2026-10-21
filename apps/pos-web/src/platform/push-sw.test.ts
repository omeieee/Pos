import { readFileSync } from 'node:fs';
import { th } from '@sds/i18n';
import { pushPayloadSchema } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';

/**
 * public/push-sw.js is plain JS imported into the generated service worker, so it is run here
 * against a made-up worker scope: the handlers it registers, the notification it shows and the
 * window it focuses or opens.
 */
const source = readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pos.example.test';

type Handler = (event: unknown) => void;
interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn> | undefined;
  postMessage: ReturnType<typeof vi.fn>;
}

function windowAt(url: string, over: Partial<FakeWindow> = {}): FakeWindow {
  const self: FakeWindow = {
    url,
    focus: vi.fn(async () => self),
    navigate: vi.fn(async () => self),
    postMessage: vi.fn(),
    ...over,
  };
  return self;
}

function load(windows: FakeWindow[] = []) {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const scope = {
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
  };
  new Function('self', source)(scope);

  const waits: Promise<unknown>[] = [];
  const push = async (data: unknown) => {
    waits.length = 0;
    const event = {
      data:
        data === undefined
          ? null
          : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    };
    handlers.get('push')?.(event);
    await Promise.all(waits);
  };
  const click = async (data: unknown) => {
    waits.length = 0;
    const close = vi.fn();
    handlers.get('notificationclick')?.({
      notification: { close, data },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
    return close;
  };
  return { handlers, showNotification, openWindow, push, click };
}

const shown = (sw: ReturnType<typeof load>) =>
  sw.showNotification.mock.calls[0] as unknown as [string, Record<string, unknown>];

describe('push: always shows a notification', () => {
  test('a good payload becomes the title, body, tag and the url to open; the tag replaces and re-alerts', async () => {
    const sw = load();
    await sw.push({
      title: 'ออเดอร์ใหม่ #L-012 (LINE)',
      body: '3 รายการ',
      url: '/#/orders/abc',
      tag: 'order-abc',
    });
    const [title, options] = shown(sw);
    expect(title).toBe('ออเดอร์ใหม่ #L-012 (LINE)');
    expect(options).toMatchObject({
      body: '3 รายการ',
      tag: 'order-abc',
      renotify: true,
      data: { url: '/#/orders/abc' },
    });
    expect(options.vibrate).toBeTruthy();
  });

  test('what the server really sends passes the shared payload schema this worker mirrors', () => {
    expect(
      pushPayloadSchema.safeParse({ title: 'x', body: 'y', url: '/#/orders/abc', tag: 'order-abc' })
        .success,
    ).toBe(true);
  });

  test.each([
    ['no data', undefined],
    ['not json', '{oops'],
    ['not an object', '42'],
    ['no title', { body: 'x', url: '/', tag: 't' }],
    ['a title that is not text', { title: 7 }],
    ['an empty title', { title: '' }],
  ])('%s: the fallback is shown, never a silent push', async (_name, data) => {
    const sw = load();
    await sw.push(data);
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = shown(sw);
    expect(title).toBe(th['push.fallback.title']);
    expect(options).toMatchObject({ body: th['push.fallback.body'], data: { url: '/' } });
  });

  test('a body, tag or url of the wrong kind falls back piece by piece', async () => {
    const sw = load();
    await sw.push({ title: 'T', body: 5, url: 'https://evil.example', tag: 9 });
    const [title, options] = shown(sw);
    expect(title).toBe('T');
    expect(options).toMatchObject({ body: '', tag: 'sds-alert', data: { url: '/' } });
  });

  test('long text is cut, not refused', async () => {
    const sw = load();
    await sw.push({
      title: 'a'.repeat(500),
      body: 'b'.repeat(500),
      url: '/',
      tag: 'c'.repeat(500),
    });
    const [title, options] = shown(sw);
    expect(title).toHaveLength(120);
    expect((options.body as string).length).toBe(200);
    expect((options.tag as string).length).toBe(100);
  });

  test('the fallback texts are the Thai catalogue ones', () => {
    expect(source).toContain(th['push.fallback.title']);
    expect(source).toContain(th['push.fallback.body']);
  });
});

describe('notificationclick: only a path inside the app is followed', () => {
  test.each([
    ['//evil.example/x'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['/has space'],
    [42],
    [undefined],
  ])('%s opens the app root instead', async (bad) => {
    const sw = load();
    const close = await sw.click({ url: bad });
    expect(close).toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  test('no window is open: a new one opens at the order', async () => {
    const sw = load();
    await sw.click({ url: '/#/orders/abc' });
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#/orders/abc`);
  });

  test('a window of the app is open: it is focused and sent to the order, nothing new opens', async () => {
    const open = windowAt(`${ORIGIN}/#/kitchen`);
    const sw = load([windowAt('https://other.example/'), open]);
    await sw.click({ url: '/#/orders/abc' });
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith(`${ORIGIN}/#/orders/abc`);
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  test('a window that cannot be navigated, or refuses, is asked by message instead', async () => {
    const cannot = windowAt(`${ORIGIN}/`, { navigate: undefined });
    await load([cannot]).click({ url: '/#/orders/abc' });
    expect(cannot.postMessage).toHaveBeenCalledWith({ type: 'sds-open', url: '/#/orders/abc' });
    const refuses = windowAt(`${ORIGIN}/`, {
      navigate: vi.fn(async () => Promise.reject(new Error('no'))),
    });
    await load([refuses]).click({ url: '/#/orders/abc' });
    expect(refuses.postMessage).toHaveBeenCalledWith({ type: 'sds-open', url: '/#/orders/abc' });
  });
});
