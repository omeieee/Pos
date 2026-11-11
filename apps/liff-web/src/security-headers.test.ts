import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * The customer app's response headers come from public/_headers via Cloudflare Pages, so a missing
 * HSTS or Permissions-Policy line is invisible to every other test. Guards the 2026-11-11 security
 * pass findings (docs/PROGRESS.md, docs/11-review-findings.md).
 */
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

describe('customer app response headers', () => {
  test('the LINE webview is kept on HTTPS after the first page', () => {
    expect(headers).toMatch(/Strict-Transport-Security: max-age=31536000/);
    expect(headers).toContain('includeSubDomains');
  });

  test('permissions the customer app never asks for are disabled', () => {
    const line = headers.split('\n').find((row) => row.trim().startsWith('Permissions-Policy:'));
    expect(line).toBeDefined();
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(line).toContain(`${feature}=()`);
    }
  });

  test('LINE pictures and the LIFF SDK keep their allowlist', () => {
    expect(headers).toMatch(/img-src[^;]*\*\.line-scdn\.net/);
    expect(headers).toMatch(/script-src[^;]*static\.line-scdn\.net/);
  });
});
