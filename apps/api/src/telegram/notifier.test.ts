import { schema } from '@sds/db';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeTelegram, OK } from '../test-support/fake-telegram.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { registerTelegramNotifier, type TelegramNotifier } from './notifier.ts';

// Made-up values only (CLAUDE.md rule 10). The token has the real shape but is not one.
const TOKEN = '123456789:AAFAKE_token_for_tests_only_0123456789ab';
const CHAT_ID = '-1009876543210';
const BASE = 'https://api.example.test';
const PICTURE = 'https://profile.line-scdn.net/0fake/picture';
const PHONE = '0899990001';
const ROOM = '1204-ROOM';
const NOTE = 'NOTE-KITCHEN-X';
const DELIVERY_NOTE = 'DELIVERY-NOTE-X';

const fake = createFakeTelegram();
let h: Harness;
let menu: Menu;
let notifier: TelegramNotifier;
let logged: Record<string, unknown>[];
let sleeps: number[];
let orderCounter = 0;

const log = {
  warn: (object: Record<string, unknown>, message: string) =>
    void logged.push({ ...object, message }),
  error: (object: Record<string, unknown>, message: string) =>
    void logged.push({ ...object, message }),
};

async function newOrder(
  options: {
    picture?: string | null;
    items?: { menuItemId: string; name: string; qty: number; removed?: boolean }[];
    total?: number;
    /** The privacy notice version the customer acknowledged; `null` for none. Default: the Telegram one. */
    ack?: string | null;
  } = {},
) {
  orderCounter += 1;
  const [customer] = await h.db
    .insert(schema.customers)
    .values({
      lineUserId: `U-tg-${orderCounter}`,
      privacyAckVersion: options.ack === undefined ? '2026-10-24' : options.ack,
    })
    .returning({ id: schema.customers.id });
  const total = options.total ?? 6200;
  const [order] = await h.db
    .insert(schema.orders)
    .values({
      orderNo: `L-${String(orderCounter).padStart(3, '0')}`,
      businessDate: '2026-10-01',
      customerId: customer?.id ?? null,
      channel: 'line',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'ตึก B',
      recipientName: 'คุณสมศรี',
      deliveryNote: DELIVERY_NOTE,
      roomNo: ROOM,
      memberPhone: PHONE,
      memberNickname: 'NICK-X',
      memberFullName: 'FULL-X',
      lineDisplayName: 'Somsri',
      linePictureUrl: options.picture === undefined ? PICTURE : options.picture,
      note: NOTE,
      status: 'new',
      paymentStatus: 'paid',
      subtotalSatang: total,
      totalSatang: total,
      clientRequestId: crypto.randomUUID(),
    })
    .returning();
  const orderId = order?.id ?? '';
  const items = options.items ?? [{ menuItemId: menu.noodles, name: 'ก๋วยเตี๋ยวต้มยำ', qty: 2 }];
  await h.db.insert(schema.orderItems).values(
    items.map((item) => ({
      orderId,
      menuItemId: item.menuItemId,
      nameThSnapshot: item.name,
      unitPriceSatang: 3100,
      qty: item.qty,
      lineTotalSatang: 3100 * item.qty,
      note: NOTE,
      ...(item.removed ? { removedAt: new Date() } : {}),
    })),
  );
  return { id: orderId, orderNo: order?.orderNo ?? '' };
}

async function withPhoto(itemId: string, version = 1) {
  await h.client.query('update menu_items set photo_version = $1 where id = $2', [version, itemId]);
}

async function alert(
  order: { id: string; orderNo: string },
  kind: 'paid' | 'slip_review' = 'paid',
) {
  h.bus.publish({ type: 'alert.payment', orderId: order.id, orderNo: order.orderNo, kind });
  await notifier.idle();
}

function everythingSent(): string {
  return JSON.stringify(fake.calls.map((c) => c.body));
}

beforeAll(async () => {
  h = await createHarness();
  menu = await h.newMenu();
  notifier = registerTelegramNotifier({
    db: h.db,
    events: h.bus,
    now: h.clock.now,
    log,
    runtime: {
      token: TOKEN,
      chatId: CHAT_ID,
      publicBaseUrl: BASE,
      transport: fake.transport,
      timeoutMs: 80,
      sleep: async (ms) => void sleeps.push(ms),
    },
  });
});
afterAll(async () => {
  notifier.stop();
  await h.close();
});
beforeEach(async () => {
  fake.reset();
  logged = [];
  sleeps = [];
  await h.client.query('update menu_items set photo_version = null');
});

describe('what is sent', () => {
  test('LINE picture first, then dish photos by absolute URL; caption on the first item', async () => {
    await withPhoto(menu.noodles, 3);
    await withPhoto(menu.water, 2);
    const order = await newOrder({
      items: [
        { menuItemId: menu.noodles, name: 'ก๋วยเตี๋ยวต้มยำ', qty: 2 },
        { menuItemId: menu.water, name: 'น้ำเปล่า', qty: 1 },
      ],
    });
    await alert(order);

    expect(fake.calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
    const call = fake.calls[0];
    expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`);
    expect(call?.body.chat_id).toBe(CHAT_ID);
    const media = call?.body.media as { type: string; media: string; caption?: string }[];
    expect(media.map((m) => m.media)).toEqual([
      PICTURE,
      `${BASE}/v1/menu/items/${menu.noodles}/photo?v=3`,
      `${BASE}/v1/menu/items/${menu.water}/photo?v=2`,
    ]);
    expect(media.every((m) => m.type === 'photo')).toBe(true);
    expect(media[0]?.caption).toBe(
      [
        `✅ ชำระแล้ว #${order.orderNo} · 62฿`,
        'LINE: Somsri',
        'ชื่อ: คุณสมศรี',
        'ตึก: ตึก B',
        'ก๋วยเตี๋ยวต้มยำ × 2',
        'น้ำเปล่า × 1',
        'รวม 62฿',
      ].join('\n'),
    );
    expect(media[1]?.caption).toBeUndefined();
    expect(call?.body.parse_mode).toBeUndefined();
  });

  test('slip_review uses the amber header', async () => {
    const order = await newOrder({ picture: null });
    await alert(order, 'slip_review');
    expect(String(fake.calls[0]?.body.text)).toContain(`🟡 ตรวจสลิป #${order.orderNo} · 62฿`);
  });

  test('never the phone, room, notes, member profile or a slip, in any call', async () => {
    await withPhoto(menu.noodles);
    await alert(await newOrder());
    await alert(await newOrder({ picture: null }), 'slip_review');
    expect(fake.calls.length).toBeGreaterThan(1);
    const sent = everythingSent();
    for (const secret of [PHONE, ROOM, NOTE, DELIVERY_NOTE, 'NICK-X', 'FULL-X', 'slip']) {
      expect(sent, secret).not.toContain(secret);
    }
  });

  test('a customer who acknowledged an older notice: number and total only, no names, dishes or photos', async () => {
    await withPhoto(menu.noodles);
    for (const ack of [null, '2026-09-01']) {
      fake.reset();
      const order = await newOrder({ ack });
      await alert(order);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.method).toBe('sendMessage');
      expect(fake.calls[0]?.body.text).toBe(`✅ ชำระแล้ว #${order.orderNo} · 62฿`);
      const sent = everythingSent();
      for (const detail of ['Somsri', 'คุณสมศรี', 'ตึก B', 'ก๋วยเตี๋ยวต้มยำ', PICTURE]) {
        expect(sent, detail).not.toContain(detail);
      }
    }
  });

  test('one photo goes as sendPhoto; none as sendMessage', async () => {
    await alert(await newOrder());
    expect(fake.calls.map((c) => c.method)).toEqual(['sendPhoto']);
    expect(fake.calls[0]?.body.photo).toBe(PICTURE);

    fake.reset();
    await alert(await newOrder({ picture: null }));
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(String(fake.calls[0]?.body.text)).toContain('ก๋วยเตี๋ยวต้มยำ × 2');
  });

  test('a picture that is not an https LINE URL is not sent on', async () => {
    await alert(await newOrder({ picture: 'https://evil.test/p.jpg' }));
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMessage']);
    fake.reset();
    await alert(await newOrder({ picture: 'http://profile.line-scdn.net/p.jpg' }));
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMessage']);
  });

  test('at most 9 dish photos after the LINE picture, once per dish', async () => {
    const category = (await h.db.select().from(schema.menuCategories).limit(1))[0];
    const extra = await h.db
      .insert(schema.menuItems)
      .values(
        Array.from({ length: 11 }, (_, i) => ({
          categoryId: category?.id ?? '',
          nameTh: `จาน ${i}`,
          priceSatang: 1000,
          photoVersion: 1,
          channels: ['line'],
        })),
      )
      .returning();
    const order = await newOrder({
      items: [
        ...extra.map((item) => ({ menuItemId: item.id, name: item.nameTh, qty: 1 })),
        { menuItemId: extra[0]?.id ?? '', name: 'ซ้ำ', qty: 1 },
      ],
    });
    await alert(order);
    const media = fake.calls[0]?.body.media as { media: string }[];
    expect(media).toHaveLength(10);
    expect(new Set(media.map((m) => m.media)).size).toBe(10);
  });

  test('removed lines are left out', async () => {
    const order = await newOrder({
      picture: null,
      items: [
        { menuItemId: menu.noodles, name: 'ก๋วยเตี๋ยวต้มยำ', qty: 1 },
        { menuItemId: menu.water, name: 'REMOVED-LINE', qty: 1, removed: true },
      ],
    });
    await alert(order);
    expect(everythingSent()).not.toContain('REMOVED-LINE');
  });

  test('a long order keeps the full text in a message after the photos', async () => {
    await withPhoto(menu.noodles);
    const items = Array.from({ length: 40 }, (_, i) => ({
      menuItemId: menu.noodles,
      name: `เมนูยาวมากมายหลายคำ ${i} `.repeat(2),
      qty: 1,
    }));
    await alert(await newOrder({ items }));
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
    const media = fake.calls[0]?.body.media as { caption?: string }[];
    expect(String(media[0]?.caption).length).toBeLessThanOrEqual(1024);
    expect(String(fake.calls[1]?.body.text)).toContain('เมนูยาวมากมายหลายคำ 39');
  });
});

describe('failure handling', () => {
  test('a refused photo (bad URL) falls back to the text alone', async () => {
    await withPhoto(menu.noodles);
    fake.script('sendMediaGroup', {
      status: 400,
      body: { ok: false, description: 'Bad Request: wrong file identifier/HTTP URL specified' },
    });
    await alert(await newOrder());
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
    expect(String(fake.calls[1]?.body.text)).toContain('ก๋วยเตี๋ยวต้มยำ × 2');
  });

  test('a media call that throws or hangs falls back too', async () => {
    await withPhoto(menu.noodles);
    fake.script('sendMediaGroup', 'throw');
    await alert(await newOrder());
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);

    fake.reset();
    fake.script('sendMediaGroup', 'hang');
    await alert(await newOrder());
    expect(fake.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
  });

  test('429: waits retry_after (capped at 5 s) and retries once', async () => {
    fake.script(
      'sendMessage',
      { status: 429, body: { ok: false, parameters: { retry_after: 2 } } },
      OK,
    );
    await alert(await newOrder({ picture: null }));
    expect(fake.callsTo('sendMessage')).toHaveLength(2);
    expect(sleeps).toEqual([2000]);

    fake.reset();
    sleeps = [];
    fake.script(
      'sendMessage',
      { status: 429, body: { ok: false, parameters: { retry_after: 600 } } },
      OK,
    );
    await alert(await newOrder({ picture: null }));
    expect(sleeps).toEqual([5000]);
  });

  test('5xx is retried once; a second failure is logged and nothing throws', async () => {
    fake.script('sendMessage', { status: 502, body: null });
    await alert(await newOrder({ picture: null }));
    expect(fake.callsTo('sendMessage')).toHaveLength(2);
    expect(logged.length).toBeGreaterThan(0);
  });

  test('a refusal that is not retryable is not retried', async () => {
    fake.script('sendMessage', { status: 403, body: { ok: false, description: 'bot was kicked' } });
    await alert(await newOrder({ picture: null }));
    expect(fake.callsTo('sendMessage')).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  test('a transport that throws never rejects idle() and the log names the order', async () => {
    fake.script('sendMessage', 'throw');
    const order = await newOrder({ picture: null });
    await expect(alert(order)).resolves.toBeUndefined();
    expect(logged.some((entry) => entry.orderId === order.id)).toBe(true);
  });

  test('an unknown order is skipped quietly', async () => {
    await alert({ id: crypto.randomUUID(), orderNo: 'L-999' });
    expect(fake.calls).toHaveLength(0);
  });

  test('logs carry no token, chat id, name, message text or URL', async () => {
    await withPhoto(menu.noodles);
    fake.script('sendMediaGroup', 'throw');
    fake.script('sendMessage', 'throw');
    await alert(await newOrder());
    fake.script('sendMessage', {
      status: 500,
      body: { ok: false, description: 'ก๋วยเตี๋ยวต้มยำ Somsri' },
    });
    await alert(await newOrder({ picture: null }));
    const text = JSON.stringify(logged) + h.logs();
    expect(logged.length).toBeGreaterThan(0);
    const secrets = [
      TOKEN,
      TOKEN.split(':')[1] ?? '',
      CHAT_ID,
      'Somsri',
      'สมศรี',
      'ก๋วยเตี๋ยว',
      'api.telegram.org',
    ];
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  });
});

describe('triggers', () => {
  test('only alert.payment sends; the same order and kind inside the window is sent once', async () => {
    const order = await newOrder({ picture: null });
    h.bus.publish({ type: 'alert.new_order', orderId: order.id } as never);
    await notifier.idle();
    expect(fake.calls).toHaveLength(0);

    await alert(order);
    await alert(order);
    expect(fake.callsTo('sendMessage')).toHaveLength(1);
    await alert(order, 'slip_review');
    expect(fake.callsTo('sendMessage')).toHaveLength(2);

    h.clock.advanceSeconds(10 * 60);
    await alert(order);
    expect(fake.callsTo('sendMessage')).toHaveLength(3);
  });

  test('stop() unsubscribes', async () => {
    const other = registerTelegramNotifier({
      db: h.db,
      events: h.bus,
      now: h.clock.now,
      log,
      runtime: { token: TOKEN, chatId: CHAT_ID, publicBaseUrl: BASE, transport: fake.transport },
    });
    other.stop();
    await alert(await newOrder({ picture: null }));
    // Only the first notifier answered.
    expect(fake.callsTo('sendMessage')).toHaveLength(1);
  });
});
