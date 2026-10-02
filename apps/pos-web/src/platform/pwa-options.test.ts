import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { pwaOptions } from '../../pwa-options.ts';

const workbox = pwaOptions.workbox ?? {};

describe('service worker rules (app shell only)', () => {
  test('nothing is cached at run time: no API answer, no sync page, no QR picture', () => {
    expect(workbox.runtimeCaching).toEqual([]);
  });

  test('offline navigation falls back to the app shell, but never for the API paths', () => {
    expect(workbox.navigateFallback).toBe('index.html');
    const denied = workbox.navigateFallbackDenylist ?? [];
    for (const path of ['/v1/sync', '/v1/payments/x/qr.png', '/v1/ws', '/healthz']) {
      expect(
        denied.some((pattern) => pattern.test(path)),
        path,
      ).toBe(true);
    }
  });

  test('only build output is precached, and no JSON (API-shaped) files', () => {
    const patterns = (workbox.globPatterns ?? []).join(',');
    expect(patterns).toContain('js');
    expect(patterns).toContain('html');
    expect(patterns).not.toContain('json');
    expect(patterns).not.toContain('_headers');
  });

  test('an old shell cannot be stranded: outdated caches are cleaned and updates are applied by the app', () => {
    expect(workbox.cleanupOutdatedCaches).toBe(true);
    expect(pwaOptions.registerType).toBe('prompt');
    expect(workbox.skipWaiting).toBe(false);
  });

  test('registration is not injected inline (the CSP forbids inline scripts)', () => {
    expect(pwaOptions.injectRegister).toBe(false);
    const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("worker-src 'self'");
  });

  test('the worker file is always revalidated, so a new version is found', () => {
    const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
    expect(headers).toMatch(/\/sw\.js\s+Cache-Control: no-cache/);
  });
});
