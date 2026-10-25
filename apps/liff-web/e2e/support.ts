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
function installFakeLiff(inClient: boolean) {
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
      isInClient: () => inClient,
      sendMessages: async () => {},
      closeWindow: () => {},
    },
  });
}

type SlipCheck = NonNullable<MyOrder['slipCheck']>;
type CancelReason = NonNullable<MyOrder['cancelReason']>;

export interface FakeOptions {
  /** The shop is not delivering right now. */
  closed?: boolean;
  /** The customer has not yet accepted the privacy notice (the default: a first visit). */
  acknowledged?: boolean;
}

export interface FakeLine {
  menuItemId: string;
  qty: number;
  optionIds: string[];
  note: string | null;
}

/** One order the fake server holds. Tests read and change these fields directly. */
export interface FakeOrder {
  id: string;
  no: string;
  lines: FakeLine[];
  building: string;
  recipient: string;
  deliveryNote: string | null;
  method: 'cash' | 'promptpay';
  version: number;
  paymentId: string;
  claimed: boolean;
  paid: boolean;
  hasSlip: boolean;
  slipCheck: SlipCheck | null;
  cancelled: { reason: CancelReason; mergedInto: string | null } | null;
}

const OPTION_DELTA: Record<string, number> = { [IDS.thin]: 0, [IDS.wide]: 1000 };
const OPTION_NAME: Record<string, string> = { [IDS.thin]: THIN_NAME, [IDS.wide]: 'เส้นใหญ่' };
const uuid = (prefix: string, n: number) =>
  `0191a8f0-0000-7000-8000-0000000000${prefix}${n.toString(16)}`.slice(0, 36);

const unit = (line: FakeLine) =>
  DISH_PRICE + line.optionIds.reduce((sum, id) => sum + (OPTION_DELTA[id] ?? 0), 0);
const totalOf = (o: FakeOrder) => o.lines.reduce((sum, l) => sum + unit(l) * l.qty, 0);
/** Nothing sent, claimed or paid yet: the customer may still change or cancel it. */
const editable = (o: FakeOrder) => o.cancelled === null && !o.paid && !o.claimed && !o.hasSlip;

/**
 * The fake API of the customer app: it keeps the customer's orders in memory and answers like the
 * real server would, so the whole flow runs in the page. `placed`, `slips` and the other logs
 * record what the page sent.
 */
export class FakeApi {
  placed: AppOrderInput[] = [];
  slips: { contentType: string; query: string }[] = [];
  claims = 0;
  /** Bodies of every `PUT /orders/:id/items`, with the order number and the idempotency key. */
  edits: {
    no: string;
    body: { expectedVersion: number; items: AppOrderInput['items'] };
    key: string | null;
  }[] = [];
  cancels: { no: string; body: { expectedVersion: number }; key: string | null }[] = [];
  merges = 0;
  orders: FakeOrder[] = [];
  /**
   * The amount the server reads off the next slip. When it is not this order's total but equals
   * this order plus the customer's other editable orders, an upload without `combine` or `review`
   * answers 409 NEEDS_COMBINE and stores nothing.
   */
  slipAmountSatang: number | null = null;
  private acknowledged: boolean;
  private paymentSeq = 0;
  private readonly closed: boolean;

  constructor(options: FakeOptions = {}) {
    this.closed = options.closed ?? false;
    this.acknowledged = options.acknowledged ?? false;
  }

  get isAcknowledged() {
    return this.acknowledged;
  }

  /** The order the test is working with: the latest one made. */
  get current(): FakeOrder {
    const order = this.orders.at(-1);
    if (!order) throw new Error('no order yet');
    return order;
  }

  total(order: FakeOrder = this.current) {
    return totalOf(order);
  }

  /** An earlier, unpaid order of this customer, as if placed in another visit. */
  seedOrder(
    over: Partial<Pick<FakeOrder, 'no' | 'lines' | 'building' | 'recipient' | 'method'>> = {},
  ): FakeOrder {
    const order: FakeOrder = {
      id: this.orders.length === 0 ? IDS.order : uuid('a', this.orders.length + 1),
      no: over.no ?? 'L-001',
      lines: over.lines ?? [{ menuItemId: IDS.dish, qty: 1, optionIds: [IDS.wide], note: null }],
      building: over.building ?? BUILDING,
      recipient: over.recipient ?? RECIPIENT,
      deliveryNote: null,
      method: over.method ?? 'promptpay',
      version: 1,
      paymentId: this.nextPaymentId(),
      claimed: false,
      paid: false,
      hasSlip: false,
      slipCheck: null,
      cancelled: null,
    };
    this.orders.push(order);
    return order;
  }

  private nextPaymentId() {
    this.paymentSeq += 1;
    return this.paymentSeq === 1 ? IDS.payment : uuid('b', this.paymentSeq);
  }

  /** The bank check ended and staff are to look at it (the neutral state). */
  staffReview(order: FakeOrder = this.current) {
    order.slipCheck = 'staff_review';
  }

  /** The bank check found a different amount. */
  amountMismatch(order: FakeOrder = this.current) {
    order.slipCheck = 'amount_mismatch';
  }

  /** The bank check passed but the shop still has to confirm. */
  verifiedWaiting(order: FakeOrder = this.current) {
    order.slipCheck = 'verified_waiting';
  }

  /** Staff confirmed the money by hand: the order turns paid. */
  confirmPaid(order: FakeOrder = this.current) {
    order.paid = true;
  }

  /** The server cancels the order (the unpaid-timeout job, for instance). */
  cancel(reason: CancelReason, order: FakeOrder = this.current, mergedInto: string | null = null) {
    order.cancelled = { reason, mergedInto };
    order.version += 1;
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

  private view(o: FakeOrder): MyOrder {
    const total = totalOf(o);
    const promptpay = o.method === 'promptpay';
    const cancelled = o.cancelled !== null;
    const open = promptpay && !o.paid && !cancelled;
    const slipCheck = open && o.claimed ? (o.slipCheck ?? 'none') : undefined;
    const payment: MyOrder['payment'] = promptpay
      ? {
          id: o.paymentId,
          method: 'promptpay',
          status: cancelled
            ? 'cancelled'
            : o.paid
              ? 'confirmed'
              : o.claimed
                ? 'claimed'
                : 'pending',
          amountSatang: total,
        }
      : null;
    const canChange = editable(o);
    return {
      id: o.id,
      orderNo: o.no,
      status: cancelled ? 'cancelled' : 'new',
      paymentStatus: o.paid ? 'paid' : o.claimed ? 'awaiting_confirmation' : 'unpaid',
      subtotalSatang: total,
      totalSatang: total,
      items: o.lines.map((l) => ({
        nameTh: DISH_NAME,
        nameEn: null,
        qty: l.qty,
        modifiers: l.optionIds.map((id) => ({ nameTh: OPTION_NAME[id] ?? '', nameEn: null })),
        note: l.note,
        lineTotalSatang: unit(l) * l.qty,
      })),
      deliveryBuilding: o.building,
      recipientName: o.recipient,
      deliveryNote: o.deliveryNote,
      note: null,
      placedAt: NOW,
      readyAt: null,
      completedAt: null,
      cancelledAt: cancelled ? NOW : null,
      cancelReason: o.cancelled?.reason ?? null,
      mergedInto: o.cancelled?.mergedInto ?? null,
      payment,
      hasSlip: o.hasSlip,
      ...(slipCheck ? { slipCheck } : {}),
      actions: {
        claim: open && !o.claimed,
        changeMethod: open && !o.claimed,
        showQr: open,
        attachSlip: open,
        methods: open && !o.claimed ? ['cash'] : [],
        edit: canChange,
        cancel: canChange,
      },
    };
  }

  private openList() {
    return {
      orders: this.orders.filter(editable).map((o) => ({
        id: o.id,
        orderNo: o.no,
        totalSatang: totalOf(o),
        version: o.version,
        businessDate: '2030-10-15',
        deliveryBuilding: o.building,
        recipientName: o.recipient,
        placedAt: NOW,
        items: o.lines.map((l) => ({
          menuItemId: l.menuItemId,
          nameTh: DISH_NAME,
          nameEn: null,
          qty: l.qty,
          modifierOptionIds: l.optionIds,
          note: l.note,
        })),
      })),
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
      // Like the real server: `download=1` makes the picture an attachment (a file to save).
      const png = () =>
        route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: PNG,
          ...(url.searchParams.get('download') === '1'
            ? { headers: { 'content-disposition': 'attachment; filename="promptpay-qr.png"' } }
            : {}),
        });
      const method = request.method();
      const key = request.headers()['idempotency-key'] ?? null;

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
      if (path === '/v1/app/orders/open' && method === 'GET') return json(this.openList());
      if (path === '/v1/app/orders' && method === 'POST') {
        const input = request.postDataJSON() as AppOrderInput;
        this.placed.push(input);
        const order = this.seedOrder({
          no: `S-${String(this.placed.length).padStart(3, '0')}`,
          lines: input.items.map((i) => ({
            menuItemId: i.menuItemId,
            qty: i.qty,
            optionIds: [...i.modifierOptionIds],
            note: i.note ?? null,
          })),
          building: input.deliveryBuilding,
          recipient: input.recipientName,
          method: input.paymentMethod === 'promptpay' ? 'promptpay' : 'cash',
        });
        order.deliveryNote = input.deliveryNote ?? null;
        return json({ order: this.view(order), paymentError: null, replay: false }, 201);
      }
      if (path === '/v1/app/orders' && method === 'GET') {
        return json({ orders: this.orders.map((o) => this.view(o)) });
      }

      const match = /^\/v1\/app\/orders\/([0-9a-f-]{36})(?:\/([a-z.]+))?$/.exec(path);
      const order = match ? this.orders.find((o) => o.id === match[1]) : undefined;
      const action = match?.[2] ?? '';
      if (order) {
        if (action === '' && method === 'GET') return json(this.view(order));
        if (action === 'claim' && method === 'POST') {
          this.claims += 1;
          order.claimed = true;
          return json(this.view(order));
        }
        if (action === 'items' && method === 'PUT') {
          const body = request.postDataJSON() as {
            expectedVersion: number;
            items: AppOrderInput['items'];
          };
          this.edits.push({ no: order.no, body, key });
          if (!editable(order)) return json({ code: 'ORDER_HAS_PAYMENT', message: 'x' }, 409);
          if (body.expectedVersion !== order.version) {
            return json({ code: 'VERSION_CONFLICT', message: 'x' }, 409);
          }
          order.lines = body.items.map((i) => ({
            menuItemId: i.menuItemId,
            qty: i.qty,
            optionIds: [...i.modifierOptionIds],
            note: i.note ?? null,
          }));
          order.version += 1;
          order.paymentId = this.nextPaymentId();
          return json(this.view(order));
        }
        if (action === 'cancel' && method === 'POST') {
          const body = request.postDataJSON() as { expectedVersion: number };
          this.cancels.push({ no: order.no, body, key });
          if (!editable(order)) return json({ code: 'ORDER_HAS_PAYMENT', message: 'x' }, 409);
          if (body.expectedVersion !== order.version) {
            return json({ code: 'VERSION_CONFLICT', message: 'x' }, 409);
          }
          this.cancel('customer_cancel', order);
          return json(this.view(order));
        }
        if (action === 'slip' && method === 'POST') {
          const combine = url.searchParams.get('combine') === '1';
          const review = url.searchParams.get('review') === '1';
          const others = this.orders.filter((o) => o !== order && editable(o));
          const sum = totalOf(order) + others.reduce((n, o) => n + totalOf(o), 0);
          const amount = this.slipAmountSatang;
          if (amount !== null && amount !== totalOf(order) && !combine && !review) {
            if (amount === sum && others.length > 0) {
              // The amount adds up to this order and the others: ask, and store nothing.
              return json(
                {
                  code: 'NEEDS_COMBINE',
                  message: 'x',
                  details: {
                    orderNos: [order.no, ...others.map((o) => o.no)],
                    orderIds: [order.id, ...others.map((o) => o.id)],
                    totalSatang: sum,
                  },
                },
                409,
              );
            }
          }
          this.slips.push({
            contentType: request.headers()['content-type'] ?? '',
            query: url.search,
          });
          if (combine) {
            // Merge into this order first (the others are cancelled `merged`), then attach.
            for (const other of others) {
              order.lines.push(...other.lines);
              this.cancel('merged', other, order.no);
            }
            this.merges += 1;
            order.version += 1;
            order.paymentId = this.nextPaymentId();
          }
          order.hasSlip = true;
          order.claimed = true;
          order.slipCheck = 'checking';
          return json(this.view(order));
        }
        if (action === 'slip' && method === 'GET') return png();
        if (action === 'qr' && method === 'GET') {
          return json({
            url: `/v1/app/orders/${order.id}/qr.png?link=1`,
            expiresAt: '2030-10-15T05:05:00.000Z',
            amountSatang: totalOf(order),
            promptpayId: MOCK_PROMPTPAY_ID,
          });
        }
        if (action === 'qr.png') return png();
      }
      // Anything else is a call the test did not expect: fail loudly instead of hanging.
      return json({ code: 'E2E_UNEXPECTED', message: `${method} ${path}` }, 404);
    });
  }
}

/**
 * Every spec gets the fake LIFF SDK in the page before any app script runs, so nothing is fetched
 * from LINE's CDN. Motion is reduced so a test taps a settled page.
 */
export const test = base.extend<{ api: FakeApi; fakeOptions: FakeOptions; inLine: boolean }>({
  fakeOptions: [{}, { option: true }],
  /** The page runs inside LINE's own browser (`liff.isInClient()` is true). */
  inLine: [false, { option: true }],
  api: async ({ fakeOptions }, use) => {
    await use(new FakeApi(fakeOptions));
  },
  page: async ({ page, api, inLine }, use) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(installFakeLiff, inLine);
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
