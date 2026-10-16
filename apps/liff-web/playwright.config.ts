import { defineConfig, devices } from '@playwright/test';

/**
 * Customer-app (LIFF) E2E with no network: the page runs on the Vite dev server, a fake `window.liff`
 * stands in for LINE's SDK, and every `/v1/*` call is answered by a fake API inside the test
 * (`e2e/support.ts`). Nothing reaches the real API, the LINE OA or a real customer.
 * Run one project at a time on a small laptop:
 *   pnpm --filter @sds/liff-web e2e --project=iphone-chromium --workers=1
 * Playwright's WebKit is not LINE's in-app browser: a real-device pass in LINE stays required.
 * Not part of `pnpm test` and not in CI (owner, 2026-10-17).
 */
const PORT = 5198;
const IPHONE = { width: 390, height: 844 };

export default defineConfig({
  testDir: './e2e',
  // `*.e2e.ts`, not `*.spec.ts`: vitest's default include would otherwise pick these up.
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone-chromium', use: { browserName: 'chromium', viewport: IPHONE } },
    { name: 'iphone-webkit', use: { browserName: 'webkit', viewport: IPHONE } },
    { name: 'iphone-firefox', use: { browserName: 'firefox', viewport: IPHONE } },
    // Android: Chrome on a Pixel 7 (its own viewport, touch and user agent).
    { name: 'android-chromium', use: { ...devices['Pixel 7'], locale: 'th-TH' } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    // An empty API base puts every call on the page's own origin, where the fake API answers it.
    env: { VITE_LIFF_ID: '0000000000-e2eexample', VITE_API_BASE_URL: '' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
