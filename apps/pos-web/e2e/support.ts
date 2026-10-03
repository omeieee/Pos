import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { translator } from '@sds/i18n';

/** Thai strings come from the app's own catalogue, so a copy change never breaks a test. */
export const tr = translator('th');

/** Made-up staff of the dev mock (src/dev/mock-server.ts). Never a real person or PIN. */
export const STAFF = {
  owner: { name: 'คุณตัวอย่าง', pin: '654321', role: 'owner' },
  manager: { name: 'ผู้จัดการตัวอย่าง', pin: '123456', role: 'manager' },
  cashier: { name: 'พนักงานตัวอย่าง', pin: '1234', role: 'cashier' },
  kitchen: { name: 'ครัวตัวอย่าง', pin: '4321', role: 'kitchen' },
} as const;
export type StaffKey = keyof typeof STAFF;

/** The dev mock's owner (made up). Each app code works once per page load, like the real server. */
export const OWNER_LOGIN = {
  email: 'owner@example.test',
  password: 'example-password',
  codes: ['111111', '222222', '333333', '444444', '555555'],
} as const;

/** The made-up PromptPay ID the mock shop pays to, and how the app shows it. */
export const MOCK_PROMPTPAY = { id: '0800001234', masked: '******1234' } as const;

/** Same breakpoint as the app shell: at or below it the cart is a sheet behind a bar. */
const PHONE_MAX_WIDTH = 719;

type DeviceKind = 'ipad' | 'iphone' | 'laptop';

/** base64url of the UTF-8 JSON, the way the mock encodes its self-describing tokens. */
function mockToken(prefix: string, value: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

/**
 * The fixtures every spec gets:
 * - `registered` (default true): the device registration the owner would have done once. The mock
 *   accepts a self-describing token, so a test starts on a registered device; the registration
 *   itself has its own test (`registered: false`).
 * - The dev "Mock network" button is hidden so it cannot cover a button or a measurement.
 * The device kind follows the project (iPhone projects get an iPhone, so the phone design tokens
 * are the ones measured).
 */
export const test = base.extend<{ registered: boolean }>({
  registered: [true, { option: true }],
  page: async ({ page, registered }, use, testInfo) => {
    const kind: DeviceKind = testInfo.project.name.startsWith('iphone') ? 'iphone' : 'ipad';
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '#sds-mock-offline{display:none!important}';
        document.head.append(style);
      });
    });
    if (registered) {
      const device = {
        id: '0192f3a0-0000-7000-8000-00000000e2e1',
        name: 'เครื่อง E2E (ตัวอย่าง)',
        kind,
      };
      const deviceToken = mockToken('sds_dev_MOCK', { ...device, n: 1 });
      await page.addInitScript(
        ([key, value]) => {
          try {
            localStorage.setItem(key as string, value as string);
          } catch {
            // storage blocked: the test then fails on the sign-in screen, which is the right signal
          }
        },
        ['sds.device.v1', JSON.stringify({ device, deviceToken })],
      );
    }
    await use(page);
  },
});
export { expect };

/** Taps a PIN on the pad. Only a 6-digit PIN signs in by itself; a shorter one needs the OK button. */
export async function tapPin(page: Page, pin: string, submitLabel = tr('auth.pin.submit')) {
  for (const digit of pin) {
    await page.locator('.pinpad .key', { hasText: new RegExp(`^${digit}$`) }).click();
  }
  if (pin.length < 6) await page.getByRole('button', { name: submitLabel, exact: true }).click();
}

export const mainNav = (page: Page) => page.getByRole('navigation', { name: tr('nav.label') });

/** Opens the app once (the mock's state lives for this page load) and signs in with a PIN. */
export async function signInWithPin(page: Page, who: StaffKey) {
  const person = STAFF[who];
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await tapPin(page, person.pin);
  await expect(mainNav(page)).toBeVisible();
}

/** A page of the signed-in app, by its address (never a reload: the mock lives in the page). */
export async function openPage(page: Page, hash: string) {
  await mainNav(page).locator(`a[href="#${hash}"]`).click();
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1000) <= PHONE_MAX_WIDTH;

/** The mock network, which the page's own fetch goes through (the browser's offline switch does not reach it). */
export async function setMockNetwork(page: Page, online: boolean) {
  await page.evaluate((off) => {
    (
      globalThis as unknown as { __sdsMock: { setOffline(on: boolean): void } }
    ).__sdsMock.setOffline(off);
  }, !online);
}

/** The connection badge of the top bar in one state (colour, icon and words: see ConnectionBadge). */
export const netBadge = (page: Page, state: 'online' | 'offline') =>
  page.locator(`.net.net--${state}`).filter({ hasText: tr(`net.${state}`) });

/** Dev-only hook of the mock: another device sends an order (the kitchen should see it). */
export async function simulateIncomingOrder(page: Page) {
  await page.evaluate(() => {
    (globalThis as unknown as { __sdsMock: { incomingOrder(): void } }).__sdsMock.incomingOrder();
  });
}

const dish = (page: Page, name: string) =>
  page.locator('.dishes').getByRole('button', { name: new RegExp(`^${name}`) });

export interface OrderSpec {
  /** Thai dish name as on the menu. */
  dish: string;
  /** Thai option names to pick in the sheet (dishes with required groups open it). */
  options?: readonly string[];
  /** Quantity set in the sheet. */
  qty?: number;
  building?: string;
  recipient?: string;
}

/** Taps a dish; a dish with required choices opens the sheet, which is filled and confirmed. */
export async function addDish(page: Page, spec: OrderSpec) {
  await dish(page, spec.dish).click();
  const sheet = page.getByRole('dialog');
  if (spec.options && spec.options.length > 0) {
    await expect(sheet).toBeVisible();
    for (const option of spec.options) {
      await sheet.locator('label.pick', { hasText: option }).click();
    }
    for (let i = 1; i < (spec.qty ?? 1); i += 1) {
      await sheet
        .getByRole('button', { name: tr('pos.orderEntry.increase', { name: spec.dish }) })
        .click();
    }
    await sheet.getByRole('button', { name: /^เพิ่ม ·/ }).click();
    await expect(sheet).toHaveCount(0);
  }
}

/** The cart is beside the menu on iPad and behind the bottom bar on iPhone. */
export async function openCart(page: Page): Promise<Locator> {
  if (isPhone(page)) {
    await page.locator('.oe__bar button').click();
    return page.getByRole('dialog');
  }
  return page.locator('.oe__cart');
}

/**
 * Rings one order from the order-entry page and waits for the server's order page. Returns the
 * order number shown there (the server's, e.g. `S-001`).
 */
export async function ringOrder(page: Page, spec: OrderSpec): Promise<string> {
  await addDish(page, spec);
  const cart = await openCart(page);
  await cart.locator('label.bld__item', { hasText: spec.building ?? 'A1' }).click();
  await cart.getByLabel(tr('pos.delivery.name')).fill(spec.recipient ?? 'คุณทดสอบ');
  await cart.getByRole('button', { name: tr('pos.orderEntry.place'), exact: true }).click();
  const heading = page.getByRole('heading', { level: 1, name: /^ออเดอร์ [A-Z]+-\d+/ });
  await expect(heading).toBeVisible();
  return ((await heading.textContent()) ?? '').replace('ออเดอร์ ', '').trim();
}

/** The payment region of the order page. */
export const paymentPanel = (page: Page) =>
  page.getByRole('region', { name: tr('payment.title'), exact: true });
