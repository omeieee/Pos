import { readFileSync } from 'node:fs';
import { catalogs } from '@sds/i18n';
import { baseTokens } from '@sds/ui';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { App } from '../App.tsx';
import { createApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { type AuthStore, createAuthStore } from '../auth/auth-store.ts';
import { createMockServer, MOCK_OWNER, MOCK_STAFF } from '../dev/mock-server.ts';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { LocaleContext } from './hooks.ts';

const th = catalogs.th;
const en = catalogs.en;

function build() {
  const server = createMockServer();
  const tokens = createMemoryTokenStore();
  let auth!: AuthStore;
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch,
    getSessionToken: () => auth.sessionToken(),
    getDeviceToken: () => auth.deviceToken(),
    onAuthFailure: (e) => auth.handleAuthFailure(e),
  });
  auth = createAuthStore({ api, tokens });
  return { auth, server, tokens };
}

const html = (auth: AuthStore, locale: 'th' | 'en' = 'th') =>
  renderToString(
    <LocaleContext.Provider value={locale}>
      <App auth={auth} />
    </LocaleContext.Provider>,
  );

async function lockedDevice() {
  const env = build();
  await env.tokens.saveDevice(env.server.issueDeviceToken('iPad เคาน์เตอร์', 'ipad'));
  await env.auth.boot();
  await env.auth.loadStaff();
  return env;
}

describe('screens (server-rendered, Thai first)', () => {
  test('before start-up: a loading splash', () => {
    const { auth } = build();
    expect(html(auth)).toContain(th['common.loading']);
  });

  test('an unregistered device: register screen with the owner sign-in form', async () => {
    const { auth } = build();
    await auth.boot();
    const page = html(auth);
    expect(page).toContain(th['auth.register.title']);
    expect(page).toContain(th['auth.owner.email']);
    expect(page).toContain(th['auth.owner.code']);
    expect(page).toContain(th['auth.owner.useRecovery']);
    expect(page).toContain('type="password"');
  });

  test('after owner sign-in: name the device, offering the three staff-app kinds only', async () => {
    const { auth } = build();
    await auth.boot();
    await auth.signInOwner({
      email: MOCK_OWNER.email,
      password: MOCK_OWNER.password,
      totp: '111111',
    });
    const page = html(auth);
    expect(page).toContain(th['auth.register.nameLabel']);
    for (const kind of ['ipad', 'iphone', 'laptop'] as const) {
      expect(page).toContain(th[`device.kind.${kind}`]);
    }
    expect(page).not.toContain(th['device.kind.print_agent']);
  });

  test('a registered device: the PIN screen with a tile per person and their role', async () => {
    const { auth } = await lockedDevice();
    const page = html(auth);
    expect(page).toContain(th['auth.pin.title']);
    expect(page).toContain('iPad เคาน์เตอร์');
    for (const person of MOCK_STAFF) {
      expect(page).toContain(person.displayName);
      expect(page).toContain(th[`role.${person.role}`]);
    }
    expect(page).toContain(th['auth.pin.ownerLink']);
  });

  test('signed in as a cashier: shop, device, person, role, sign out, and only the Orders page', async () => {
    const { auth } = await lockedDevice();
    const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
    await auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
    const page = html(auth);
    expect(page).toContain('แซ่บโดนเส้น');
    expect(page).toContain(cashier?.displayName);
    expect(page).toContain(th['role.cashier']);
    expect(page).toContain(th['shell.signOut']);
    expect(page).toContain(th['nav.orders']);
    expect(page).not.toContain('href="#/menu"');
    expect(page).not.toContain('href="#/settings"');
    expect(page).toContain(th['comingSoon.title']);
    // Buddhist Era year (2026 -> 2569 and later).
    expect(page).toMatch(/25[6-9]\d/);
  });

  test('signed in as the owner: all three pages', async () => {
    const { auth } = await lockedDevice();
    await auth.signInOwner({
      email: MOCK_OWNER.email,
      password: MOCK_OWNER.password,
      totp: '111111',
    });
    const page = html(auth);
    for (const route of ['orders', 'menu', 'settings']) {
      expect(page).toContain(`href="#/${route}"`);
    }
  });

  test('the step-up dialog asks for a PIN from a cashier and a password from the owner', async () => {
    const { auth } = await lockedDevice();
    const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
    await auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
    void auth.ensureStepUp();
    const cashierPage = html(auth);
    expect(cashierPage).toContain('role="dialog"');
    expect(cashierPage).toContain(th['auth.stepUp.pinHint']);
    expect(cashierPage).not.toContain('type="password"');
    auth.cancelStepUp();

    await auth.signOut();
    await auth.signInOwner({
      email: MOCK_OWNER.email,
      password: MOCK_OWNER.password,
      totp: '222222',
    });
    void auth.ensureStepUp();
    const ownerPage = html(auth);
    expect(ownerPage).toContain(th['auth.stepUp.ownerHint']);
    expect(ownerPage).toContain('type="password"');
    auth.cancelStepUp();
  });

  test('English is complete: the same screens render in English', async () => {
    const { auth } = await lockedDevice();
    const page = html(auth, 'en');
    expect(page).toContain(en['auth.pin.title']);
    expect(page).not.toContain(th['auth.pin.title']);
  });

  test('the notice explains why the person is back at the PIN screen', async () => {
    const { auth } = await lockedDevice();
    const cashier = MOCK_STAFF.find((s) => s.role === 'cashier');
    await auth.signInWithPin(cashier?.id ?? '', cashier?.pin ?? '');
    auth.handleAuthFailure(new ApiClientError('UNAUTHENTICATED', { status: 401 }));
    expect(html(auth)).toContain(th['auth.notice.sessionExpired']);
  });
});

describe('styles and manifest follow the design tokens', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  test('no colour is typed into the stylesheet', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  test('the Home Screen manifest uses the token colours', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'),
    );
    expect(manifest.background_color.toLowerCase()).toBe(baseTokens.color.bg.toLowerCase());
    expect(manifest.theme_color.toLowerCase()).toBe(baseTokens.color.brand.toLowerCase());
    expect(manifest.lang).toBe('th');
    expect(manifest.display).toBe('standalone');
  });
});
