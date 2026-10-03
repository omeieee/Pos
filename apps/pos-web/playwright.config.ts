import { defineConfig } from '@playwright/test';

/**
 * Staff-app E2E against the dev mock (`VITE_MOCK_API=1`): no API, no network, mock IDs only.
 * Run one project at a time on a small laptop:
 *   pnpm --filter @sds/pos-web e2e --project=ipad-chromium --workers=1
 * Playwright's WebKit is not iOS Safari: a real-device pass on the iPad and iPhone stays required.
 * Not part of `pnpm test` (kept fast). A CI job would run
 *   pnpm --filter @sds/pos-web exec playwright install --with-deps
 *   pnpm --filter @sds/pos-web e2e
 */
const PORT = 5199;
const IPAD = { width: 1180, height: 820 };
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
    { name: 'ipad-chromium', use: { browserName: 'chromium', viewport: IPAD } },
    { name: 'ipad-webkit', use: { browserName: 'webkit', viewport: IPAD } },
    { name: 'ipad-firefox', use: { browserName: 'firefox', viewport: IPAD } },
    { name: 'iphone-chromium', use: { browserName: 'chromium', viewport: IPHONE } },
    { name: 'iphone-webkit', use: { browserName: 'webkit', viewport: IPHONE } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    env: { VITE_MOCK_API: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
