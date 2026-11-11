import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * The staff app's response headers are served by Cloudflare Pages from public/_headers, not by the
 * app at run time, so nothing else would catch a directive that silently drops LINE avatars or a
 * missing HSTS/Permissions-Policy line. This file guards the three findings from the 2026-11-11
 * security pass (docs/PROGRESS.md, docs/11-review-findings.md).
 */
const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');

describe('staff app response headers', () => {
  test('LINE profile pictures are allowed (kitchen tickets and the payment pop-up)', () => {
    expect(headers).toMatch(/img-src[^;]*https:\/\/profile\.line-scdn\.net/);
  });

  test('every page is HTTPS-only once a device has seen it', () => {
    expect(headers).toMatch(/Strict-Transport-Security: max-age=31536000/);
    expect(headers).toContain('includeSubDomains');
  });

  test('permissions the app never asks for are disabled, with wake lock and clipboard left alone', () => {
    const line = headers.split('\n').find((row) => row.trim().startsWith('Permissions-Policy:'));
    expect(line).toBeDefined();
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(line).toContain(`${feature}=()`);
    }
    // The kitchen keeps its screen awake and the staff copy share links, so these stay at "self".
    expect(line).not.toContain('screen-wake-lock');
    expect(line).not.toContain('clipboard-write');
  });
});
