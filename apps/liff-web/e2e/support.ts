import { test as base, expect, type Page } from '@playwright/test';
import { formatBaht, translator } from '@sds/i18n';
import {
  type AppOrderInput,
  type CheckoutInfo,
  type MyOrder,
  type PublicMenuResponse,
  satang,
} from '@sds/shared';

/** Thai strings come from the app's own catalogue, so a copy change never breaks a test. */
export const tr = translator('th');

/** Made-up ids and names. Never a real person, phone number or PromptPay ID. */
export const IDS = {
  category: '0191a8f0-0000-7000-8000-000000000100',
  dish: '0191a8f0-0000-7000-8000-000000000001',
  group: '0191a8f0-0000-7000-8000-000000000010',
  thin: '0191a8f0-0000-7000-8000-000000000011',
  wide: '0191a8f0-0000-7000-8000-000000000012',
  order: '0191a8f0-0000-7000-8000-0000000000a1',
  payment: '0191a8f0-0000-7000-8000-0000000000b1',
} as const;
export const DISH_NAME = 'ก๋วยเตี๋ยวตัวอย่าง';
export const THIN_NAME = 'เส้นเล็ก';
export const MOCK_PROMPTPAY_ID = '0800001234';
export const RECIPIENT = 'คุณตัวอย่าง';
export const BUILDING = 'A1';

const DISH_PRICE = satang(5000);
const NOW = '2030-10-15T05:00:00.000Z';

const MENU: PublicMenuResponse = {
  channel: 'line',
  categories: [
    {
      id: IDS.category,
      nameTh: 'หมวดตัวอย่าง',
      nameEn: null,
      items: [
        {
          id: IDS.dish,
          nameTh: DISH_NAME,
          nameEn: null,
          descriptionTh: null,
          descriptionEn: null,
          priceSatang: DISH_PRICE,
          imageUrl: null,
          modifierGroups: [
            {
              id: IDS.group,
              nameTh: 'เส้น',
              nameEn: null,
              minSelect: 1,
              maxSelect: 1,
              options: [
                { id: IDS.thin, nameTh: THIN_NAME, nameEn: null, priceDeltaSatang: satang(0) },
                { id: IDS.wide, nameTh: 'เส้นใหญ่', nameEn: null, priceDeltaSatang: satang(1000) },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A real, valid 2x2 PNG: the QR and the slip pictures are decoded by the page. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDKgA' +
    'wAAUgYEAdMKdXYAAAAASUVORK5CYII=',
  'base64',
);

/** The phone's fake LINE SDK: signed in, a plain browser tab (not LINE's own client). */
function installFakeLiff() {
  // Records the size of every request body the page sends, measured here in the page: a browser's
  // test hook may not expose a Blob body (WebKit), but the page always knows what it sent.
  const sent: { url: string; method: string; bytes: number | null }[] = [];
  Object.assign(window, { __sent: sent });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const body = init?.body;
    const bytes =
      body instanceof Blob ? body.size : typeof body === 'string' ? new Blob([body]).size : null;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, method: init?.method ?? 'GET', bytes });
    return realFetch(input, init);
  };
  const idToken = `e2e-id-token-${'x'.repeat(40)}`;
  Object.assign(window, {
    liff: {
      init: async () => {},
      isLoggedIn: () => true,
      login: () => {},
      getIDToken: () => idToken,
      getAccessToken: () => null,
      getDecodedIDToken: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      getContext: () => ({ type: 'utou' }),
      isInClient: () => false,
      sendMessages: async () => {},
      closeWindow: () => {},
    },
  });
}

type SlipCheck = NonNullable<MyOrder['slipCheck']>;

export interface FakeOptions {
  /** The shop is not delivering right now. */
  closed?: boolean;
  /** The customer has not yet accepted the privacy notice (the default: a first visit). */
  acknowledged?: boolean;
}

/**
 * The fake API of the customer app: it keeps one order in memory and answers like the real server
 * would, so the whole flow runs in the page. `calls` records what the page sent.
 */
export class FakeApi {
  placed: AppOrderInput[] = [];
  slips: { contentType: string }[] = [];
  claims = 0;
  private acknowledged: boolean;
  private order: MyOrder | null = null;
  private slipCheck: SlipCheck | null = null;
  private paid = false;
  private claimed = false;
  private hasSlip = false;
  private method: 'cash' | 'promptpay' = 'promptpay';
  private readonly closed: boolean;

  constructor(options: FakeOptions = {}) {
    this.closed = options.closed ?? false;
    this.acknowledged = options.acknowledged ?? false;
  }

  get isAcknowledged() {
    return this.acknowledged;
  }

  /** The bank check ended and staff are to look at it (the neutral state). */
  staffReview() {
    this.slipCheck = 'staff_review';
  }

  /** Staff confirmed the money by hand: the order turns paid. */
  confirmPaid() {
    this.paid = true;
  }

  private checkout(): CheckoutInfo {
    return {
      delivery: this.closed
        ? { open: false, window: { openMinute: 780, closeMinute: 1380 }, mode: 'scheduled' }
        : { open: true, window: { openMinute: 0, closeMinute: 1439 }, mode: 'open' },
      buildings: [BUILDING, 'B2'],
      methods: ['cash', 'promptpay'],
      lastRecipient: null,
      privacyAcknowledged: this.acknowledged,
      privacyVersion: 'e2e',
      promptpayConfigured: true,
      shopPhone: null,
    };
  }

  private view(): MyOrder {
    const input = this.placed.at(-1);
    if (!input) throw new Error('no order placed');
    const total = DISH_PRICE * (input.items[0]?.qty ?? 1);
    const promptpay = this.method === 'promptpay';
    const open = promptpay && !this.paid;
    const slipCheck = open && this.claimed ? (this.slipCheck ?? 'none') : undefined;
    const payment: MyOrder['payment'] = promptpay
      ? {
          id: IDS.payment,
          method: 'promptpay',
          status: this.paid ? 'confirmed' : this.claimed ? 'claimed' : 'pending',
          amountSatang: total,
        }
      : null;
    return {
      id: IDS.order,
      orderNo: 'S-001',
      status: 'new',
      paymentStatus: this.paid ? 'paid' : this.claimed ? 'awaiting_confirmation' : 'unpaid',
      subtotalSatang: total,
      totalSatang: total,
      items: [
        {
          nameTh: DISH_NAME,
          nameEn: null,
          qty: input.items[0]?.qty ?? 1,
          modifiers: [{ nameTh: THIN_NAME, nameEn: null }],
          note: null,
          lineTotalSatang: total,
        },
      ],
      deliveryBuilding: input.deliveryBuilding,
      recipientName: input.recipientName,
      deliveryNote: input.deliveryNote ?? null,
      note: null,
      placedAt: NOW,
      readyAt: null,
      completedAt: null,
      cancelledAt: null,
      payment,
      hasSlip: this.hasSlip,
      ...(slipCheck ? { slipCheck } : {}),
      actions: {
        claim: open && !this.claimed,
        changeMethod: open && !this.claimed,
        showQr: open,
        attachSlip: open,
        methods: open && !this.claimed ? ['cash'] : [],
      },
    };
  }

  /** Answers one request of the page; the paths and bodies are the ones `src/api/client.ts` sends. */
  async handle(page: Page): Promise<void> {
    await page.route('**/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const png = () => route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      const method = request.method();

      if (path === '/v1/menu') return json(MENU);
      if (path === '/v1/app/session' && method === 'POST') {
        return json({
          token: 'e2e-session-token',
          expiresAt: '2030-10-15T06:00:00.000Z',
          privacyAcknowledged: this.acknowledged,
          privacyVersion: 'e2e',
        });
      }
      if (path === '/v1/app/checkout') return json(this.checkout());
      if (path === '/v1/app/privacy-ack' && method === 'POST') {
        this.acknowledged = true;
        return json({ privacyAcknowledged: true, privacyVersion: 'e2e' });
      }
      if (path === '/v1/app/orders' && method === 'POST') {
        const input = request.postDataJSON() as AppOrderInput;
        this.placed.push(input);
        this.method = input.paymentMethod === 'promptpay' ? 'promptpay' : 'cash';
        this.order = this.view();
        return json({ order: this.order, paymentError: null, replay: false }, 201);
      }
      if (path === '/v1/app/orders' && method === 'GET') {
        return json({ orders: this.placed.length > 0 ? [this.view()] : [] });
      }
      if (path === `/v1/app/orders/${IDS.order}` && method === 'GET') return json(this.view());
      if (path === `/v1/app/orders/${IDS.order}/claim` && method === 'POST') {
        this.claims += 1;
        this.claimed = true;
        return json(this.view());
      }
      if (path === `/v1/app/orders/${IDS.order}/slip` && method === 'POST') {
        this.slips.push({ contentType: request.headers()['content-type'] ?? '' });
        this.hasSlip = true;
        this.claimed = true;
        this.slipCheck = 'checking';
        return json(this.view());
      }
      if (path === `/v1/app/orders/${IDS.order}/slip` && method === 'GET') return png();
      if (path === `/v1/app/orders/${IDS.order}/qr` && method === 'GET') {
        return json({
          url: `/v1/app/orders/${IDS.order}/qr.png?link=1`,
          expiresAt: '2030-10-15T05:05:00.000Z',
          amountSatang: DISH_PRICE,
          promptpayId: MOCK_PROMPTPAY_ID,
        });
      }
      if (path === `/v1/app/orders/${IDS.order}/qr.png`) return png();
      // Anything else is a call the test did not expect: fail loudly instead of hanging.
      return json({ code: 'E2E_UNEXPECTED', message: `${method} ${path}` }, 404);
    });
  }
}

/**
 * Every spec gets the fake LIFF SDK in the page before any app script runs, so nothing is fetched
 * from LINE's CDN. Motion is reduced so a test taps a settled page.
 */
export const test = base.extend<{ api: FakeApi; fakeOptions: FakeOptions }>({
  fakeOptions: [{}, { option: true }],
  api: async ({ fakeOptions }, use) => {
    await use(new FakeApi(fakeOptions));
  },
  page: async ({ page, api }, use) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(installFakeLiff);
    await api.handle(page);
    await use(page);
  },
});
export { expect };

/** The page must never scroll sideways: a phone shows the whole width. */
export async function expectNoSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
}

/** Opens the menu, accepting the privacy notice first when the fake server will ask for it. */
export async function openMenu(page: Page, api: FakeApi) {
  await page.goto('/');
  if (!api.isAcknowledged) {
    // The menu may show for a moment before the checkout info arrives: the notice replaces it.
    const accept = page.getByRole('button', { name: tr('liff.privacy.accept') });
    await expect(accept).toBeVisible();
    await expectNoSideScroll(page);
    await accept.click();
  }
  await expect(page.getByRole('heading', { name: DISH_NAME })).toBeVisible();
}

/** The body sizes the page sent to one API path, as the page measured them. */
export async function sentTo(page: Page, path: string) {
  return page.evaluate(
    (suffix) =>
      (
        window as unknown as { __sent: { url: string; method: string; bytes: number | null }[] }
      ).__sent.filter((r) => r.url.endsWith(suffix)),
    path,
  );
}

/** Adds the sample dish with the thin noodles and goes to the checkout. */
export async function addDishAndCheckout(page: Page) {
  await page.getByRole('button', { name: `${tr('liff.menu.add')} ${DISH_NAME}` }).click();
  const sheet = page.getByRole('dialog');
  const add = sheet.getByRole('button', {
    name: tr('liff.option.add', { amount: formatBaht(DISH_PRICE, 'th') }),
  });
  // The noodle choice is required: the add button stays off until one is picked.
  await expect(add).toBeDisabled();
  await sheet.getByRole('radio', { name: new RegExp(THIN_NAME) }).check();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: new RegExp(tr('liff.menu.toPay')) }).click();
}
