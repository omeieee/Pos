/*
 * Phone alerts (Web Push) for the staff app. Loaded into the generated service worker with
 * workbox `importScripts` (pwa-options.ts), so it is copied as it is, not bundled: plain JS, no
 * imports. The server sends {title, body, url, tag} (apps/api/src/push/payload.ts): a short title,
 * an item count, a path inside the app and a tag that replaces an older alert of the same order.
 * No personal data is in it, and none is expected.
 *
 * Every push MUST show a notification (Safari drops the subscription after a silent push, Chrome
 * shows its own generic notice), so a message that is missing or malformed still shows the fallback
 * below. The worker cannot read the i18n catalogue; src/platform/push-sw.test.ts pins the two
 * fallback texts to the `push.fallback.*` keys.
 */

const FALLBACK_TITLE = 'มีออเดอร์ใหม่';
const FALLBACK_BODY = 'เปิดแอปเพื่อดูออเดอร์';
const FALLBACK_TAG = 'sds-alert';
const ICON = '/icons/icon-192.png';
/** A path inside the app: one leading slash, never `//host` or `/\host`, no spaces. */
const SAFE_PATH = /^\/(?![/\\])[^\s\\]{0,300}$/;

const asText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

const safePath = (value) => (typeof value === 'string' && SAFE_PATH.test(value) ? value : '/');

/** What to show for a push event, whatever it carried. */
function readAlert(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const title = data && typeof data === 'object' ? asText(data.title, 120) : '';
  if (title === '') {
    return { title: FALLBACK_TITLE, body: FALLBACK_BODY, url: '/', tag: FALLBACK_TAG };
  }
  return {
    title,
    body: asText(data.body, 200),
    url: safePath(data.url),
    tag: asText(data.tag, 100) || FALLBACK_TAG,
  };
}

self.addEventListener('push', (event) => {
  const alert = readAlert(event);
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      tag: alert.tag,
      // A newer alert with the same tag replaces the old one and still makes a sound.
      renotify: true,
      icon: ICON,
      lang: 'th',
      vibrate: [200, 100, 200],
      data: { url: alert.url },
    }),
  );
});

/** Focuses a window of the app and sends it to `target`; false when there is none. */
async function focusAppWindow(origin, target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find(
    (client) => new URL(client.url).origin === origin && typeof client.focus === 'function',
  );
  if (!existing) return false;
  const shown = (await existing.focus()) || existing;
  // Not every engine can navigate a window it does not control: the page listens for this.
  const ask = () =>
    shown.postMessage({ type: 'sds-open', url: target.pathname + target.search + target.hash });
  if (typeof shown.navigate !== 'function') ask();
  else await shown.navigate(target.href).catch(ask);
  return true;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const origin = self.location.origin;
  let target = new URL(safePath(event.notification.data?.url), origin);
  // Belt and braces: the pattern already refuses anything off this origin.
  if (target.origin !== origin) target = new URL('/', origin);
  event.waitUntil(
    focusAppWindow(origin, target).then((focused) =>
      focused ? undefined : self.clients.openWindow(target.href),
    ),
  );
});
