/**
 * Phone alerts seam (Web Push): features call `PushPlatform`; the browser APIs (`Notification`,
 * the service worker, `PushManager`) are touched only here, so the P10 shells can swap in native
 * push (APNs / FCM) and no screen changes.
 *
 * Browser rules this follows:
 * - iPhone and iPad (iOS / iPadOS 16.4+) only have Web Push for an app opened from its Home Screen
 *   icon. In a Safari tab there is no `PushManager`, so "not installed" is detected from the
 *   device kind plus the display mode, not from the missing API. iPadOS reports itself as a Mac with
 *   a touch screen. An installed app without `PushManager` is an iOS before 16.4: unsupported.
 * - The permission prompt and `pushManager.subscribe()` only count as user-initiated when they start
 *   in the tap's own tick: `subscribe()` MUST be called synchronously from the tap handler (no
 *   `await` before it), like `SoundPlayer.turnOn()`.
 * - `navigator.serviceWorker.ready` never settles when no worker is registered (the dev server, a
 *   first visit that opens this page before registration), so it is raced against a timeout.
 * - Chrome refuses `subscribe()` with a different key while another subscription exists, so a
 *   subscription with another key is dropped first.
 */

export type PushPermission = 'default' | 'granted' | 'denied';

/** What the browser hands back, reduced to what the server stores plus the key it was made with. */
export interface DeviceSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The VAPID public key (base64url, no padding) the subscription was made for; null when the engine does not say. */
  applicationServerKey: string | null;
}

export type PushFailure = 'denied' | 'dismissed' | 'unsupported' | 'failed';

export class PushPlatformError extends Error {
  readonly code: PushFailure;
  constructor(code: PushFailure) {
    super(code);
    this.name = 'PushPlatformError';
    this.code = code;
  }
}

export interface PushPlatform {
  /** Can this browser subscribe at all (service worker, push, notifications)? */
  isSupported(): boolean;
  /** An iPhone or iPad running in a Safari tab: alerts need the app added to the Home Screen first. */
  needsInstall(): boolean;
  permission(): PushPermission;
  /**
   * Asks for the permission when it is still `default`, then subscribes. Call it synchronously
   * from a tap. Rejects with `PushPlatformError`: `denied` (blocked), `dismissed` (prompt closed
   * without an answer), `unsupported`, `failed`.
   */
  subscribe(publicKey: string): Promise<DeviceSubscription>;
  /** Drops this browser's subscription; resolves when there was none. */
  unsubscribe(): Promise<void>;
  getSubscription(): Promise<DeviceSubscription | null>;
}

// ---------- base64url ----------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += ALPHABET[c & 63];
  }
  return out;
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/=+$/, '');
  const bytes = new Uint8Array(new ArrayBuffer(Math.floor((clean.length * 6) / 8)));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new PushPlatformError('failed');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at] = (value >> bits) & 255;
      at += 1;
    }
  }
  return bytes;
}

/** Same key, ignoring any `=` padding. */
export const sameKey = (a: string, b: string): boolean =>
  a.replace(/=+$/, '') === b.replace(/=+$/, '');

// ---------- the web implementation ----------

/** The part of `PushSubscription` that is used. */
export interface BrowserSubscription {
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  options?: { applicationServerKey?: ArrayBuffer | null };
  unsubscribe(): Promise<boolean>;
}

/** The part of `ServiceWorkerRegistration` that is used. */
export interface BrowserRegistration {
  pushManager: {
    getSubscription(): Promise<BrowserSubscription | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: BufferSource;
    }): Promise<BrowserSubscription>;
  };
}

/** What the browser says about itself; tests hand in their own. */
export interface PushEnvironment {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Running from the Home Screen icon (`navigator.standalone` or `display-mode: standalone`). */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  notificationPermission(): PushPermission;
  requestPermission(): Promise<PushPermission>;
  /** The active worker's registration; rejects when there is none after the wait. */
  registration(): Promise<BrowserRegistration>;
}

const READY_TIMEOUT_MS = 8000;

export function browserEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  const permission = (): PushPermission => {
    const value = typeof Notification === 'undefined' ? 'denied' : Notification.permission;
    return value === 'granted' || value === 'denied' ? value : 'default';
  };
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standalone:
      nav.standalone === true ||
      (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches),
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    notificationPermission: permission,
    requestPermission: async () => {
      const value = await Notification.requestPermission();
      return value === 'granted' || value === 'denied' ? value : 'default';
    },
    registration: () =>
      Promise.race([
        navigator.serviceWorker.ready as Promise<BrowserRegistration>,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new PushPlatformError('failed')), READY_TIMEOUT_MS),
        ),
      ]),
  };
}

const isIosDevice = (env: PushEnvironment): boolean =>
  /iPhone|iPad|iPod/.test(env.userAgent) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);

function toDevice(subscription: BrowserSubscription): DeviceSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new PushPlatformError('failed');
  const key = subscription.options?.applicationServerKey;
  return {
    endpoint: json.endpoint,
    keys: { p256dh, auth },
    applicationServerKey: key ? bytesToBase64Url(new Uint8Array(key)) : null,
  };
}

export function createWebPush(provided?: PushEnvironment): PushPlatform {
  // Read the browser lazily: building the app touches no browser API until a screen asks.
  let found: PushEnvironment | undefined = provided;
  const e = (): PushEnvironment => {
    found ??= browserEnvironment();
    return found;
  };
  // Apple allows Web Push only for a Home Screen app, whatever else the tab can do.
  const needsInstall = () => isIosDevice(e()) && !e().standalone;
  const supported = () => e().hasServiceWorker && e().hasPushManager && e().hasNotification;

  async function current(): Promise<BrowserSubscription | null> {
    const registration = await e().registration();
    return registration.pushManager.getSubscription();
  }

  return {
    isSupported: supported,
    needsInstall,
    permission: () => (e().hasNotification ? e().notificationPermission() : 'denied'),

    subscribe(publicKey) {
      if (!supported()) return Promise.reject(new PushPlatformError('unsupported'));
      // The prompt starts in this tick, before anything is awaited.
      const asking =
        e().notificationPermission() === 'default'
          ? e().requestPermission()
          : Promise.resolve(e().notificationPermission());
      return (async () => {
        const answer = await asking;
        if (answer === 'denied') throw new PushPlatformError('denied');
        if (answer !== 'granted') throw new PushPlatformError('dismissed');
        try {
          const registration = await e().registration();
          const existing = await registration.pushManager.getSubscription();
          if (existing) {
            const device = toDevice(existing);
            if (device.applicationServerKey && sameKey(device.applicationServerKey, publicKey)) {
              return device;
            }
            await existing.unsubscribe();
          }
          const made = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToBytes(publicKey),
          });
          return toDevice(made);
        } catch (caught) {
          throw caught instanceof PushPlatformError ? caught : new PushPlatformError('failed');
        }
      })();
    },

    async unsubscribe() {
      if (!supported()) return;
      const subscription = await current();
      if (subscription) await subscription.unsubscribe();
    },

    async getSubscription() {
      if (!supported()) return null;
      const subscription = await current();
      return subscription ? toDevice(subscription) : null;
    },
  };
}

// ---------- opening an order from a tapped alert ----------

/** A hash route the worker may ask the page to open: `/#/orders/<id>`, nothing else. */
const OPEN_ROUTE = /^\/#(\/[A-Za-z0-9._~-]+)+$/;

/**
 * The worker tells an open page to go to the order of a tapped alert when the browser would not
 * let it navigate the window itself. Only a hash route inside the app is followed. Returns the
 * function that stops listening.
 */
export function listenForOpenRequests(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const { type, url } = data as { type?: unknown; url?: unknown };
    if (type === 'sds-open' && typeof url === 'string' && OPEN_ROUTE.test(url)) {
      window.location.hash = url.slice(1);
    }
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
