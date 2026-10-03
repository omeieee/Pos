import { describe, expect, test } from 'vitest';
import {
  type FlexNode,
  followGreeting,
  menuLink,
  methodPicker,
  orderConfirmation,
  orderStatusCard,
  payInfoCard,
  paymentInstructions,
  readyWithReceipt,
  receiptCard,
} from './flex.ts';
import { parsePostback } from './postback.ts';

const ORDER_ID = '0191a8f0-0000-7000-8000-000000000001';
const items = [
  { name: 'ก๋วยเตี๋ยวต้มยำ', quantity: 2, lineTotalSatang: 11000 },
  { name: 'น้ำเปล่า', quantity: 1, lineTotalSatang: 1000 },
];

/** Every node in a Flex tree. */
function walk(node: unknown, out: FlexNode[] = []): FlexNode[] {
  if (Array.isArray(node)) for (const n of node) walk(n, out);
  else if (node && typeof node === 'object') {
    out.push(node as FlexNode);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
}
const allText = (m: unknown) =>
  walk(m)
    .map((n) => (typeof n.text === 'string' ? n.text : ''))
    .join('\n');

describe('orderConfirmation', () => {
  const msg = orderConfirmation({
    orderNo: 'L-012',
    items,
    totalSatang: 12000,
    building: 'B1',
    recipientName: 'ฟ้า',
  });

  test('snapshot', () => expect(msg).toMatchSnapshot());
  test('has altText and shows the server total', () => {
    expect(msg.altText).toContain('L-012');
    expect(msg.altText.length).toBeLessThanOrEqual(400);
    expect(allText(msg)).toContain('฿120.00');
  });
});

describe('paymentInstructions', () => {
  const common = { orderNo: 'L-012', orderId: ORDER_ID, totalSatang: 12050 };

  const ORDER_URL = 'https://liff.line.me/1234567890-abcdefgh/orders/' + ORDER_ID;

  test('promptpay: ID and exact amount in the text, a button to the order page, and NO image', () => {
    const msg = paymentInstructions({
      ...common,
      method: 'promptpay',
      promptpayId: '0812345678',
      orderUrl: ORDER_URL,
    });
    expect(msg).toMatchSnapshot();
    expect(allText(msg)).toContain('0812345678');
    expect(allText(msg)).toContain('฿120.50');
    // A QR picture in a chat card would outlive its five-minute signed link: never embedded.
    expect(walk(msg).filter((n) => n.type === 'image')).toHaveLength(0);
    expect(JSON.stringify(msg)).not.toMatch(/qr\.png|sig=/i);
    const buttons = walk(msg).filter((n) => n.type === 'button');
    const actions = buttons.map((b) => b.action as { type: string; uri?: string; data?: string });
    expect(actions[0]).toMatchObject({ type: 'uri', uri: ORDER_URL });
    expect(actions.slice(1).map((a) => parsePostback(a.data ?? ''))).toEqual([
      { action: 'paid', orderId: ORDER_ID },
      { action: 'change_method', orderId: ORDER_ID },
    ]);
  });

  test('promptpay refuses a non-https order link', () => {
    expect(() =>
      paymentInstructions({
        ...common,
        method: 'promptpay',
        promptpayId: '0812345678',
        orderUrl: 'http://x/orders/1',
      }),
    ).toThrow(RangeError);
  });

  test('gov_copay: pay at the hand-over, and the message holds no image, no QR, no URL', () => {
    const msg = paymentInstructions({ ...common, method: 'gov_copay' });
    expect(msg).toMatchSnapshot();
    const nodes = walk(msg);
    expect(nodes.filter((n) => n.type === 'image')).toHaveLength(0);
    const json = JSON.stringify(msg);
    expect(json).not.toMatch(/https?:/i);
    expect(json).not.toMatch(/qr\.png/i);
    expect(allText(msg)).toContain('ทางเข้าตึก');
    expect(allText(msg)).toContain('ไม่ส่ง QR ทาง LINE');
  });

  test('cash: pay at hand-over, no image', () => {
    const msg = paymentInstructions({ ...common, method: 'cash' });
    expect(msg).toMatchSnapshot();
    expect(walk(msg).filter((n) => n.type === 'image')).toHaveLength(0);
  });

  test('English locale', () => {
    const msg = paymentInstructions({ ...common, method: 'cash' }, 'en');
    expect(allText(msg)).toContain('Pay cash');
  });
});

describe('readyWithReceipt', () => {
  const msg = readyWithReceipt({
    orderNo: 'L-012',
    building: 'B1',
    items,
    totalSatang: 12000,
    methodLabel: 'พร้อมเพย์',
  });
  test('snapshot', () => expect(msg).toMatchSnapshot());
  test('carries ready, every item, the total and the method', () => {
    const text = allText(msg);
    expect(text).toContain('อาหารพร้อมแล้ว');
    expect(text).toContain('ก๋วยเตี๋ยวต้มยำ');
    expect(text).toContain('฿120.00');
    expect(text).toContain('พร้อมเพย์');
    expect(msg.altText).toContain('L-012');
  });
});

describe('followGreeting', () => {
  const base = { controller: 'omeie', contactEmail: 'owner@example.test' };
  test('greeting text, then the privacy card with the controller, contact and ack button', () => {
    const msgs = followGreeting(base);
    expect(msgs).toMatchSnapshot();
    expect(msgs).toHaveLength(2);
    expect(allText(msgs[1])).toContain('omeie');
    expect(allText(msgs[1])).toContain('owner@example.test');
    const buttons = walk(msgs[1]).filter((n) => n.type === 'button');
    const last = buttons[buttons.length - 1] as unknown as { action: { data: string } };
    expect(parsePostback(last.action.data)).toEqual({ action: 'ack_privacy' });
  });
  test('adds a notice link only when given, and only https', () => {
    expect(JSON.stringify(followGreeting(base))).not.toContain('"uri"');
    expect(JSON.stringify(followGreeting({ ...base, noticeUrl: 'https://x.test/p' }))).toContain(
      '"uri":"https://x.test/p"',
    );
    expect(() => followGreeting({ ...base, noticeUrl: 'http://x.test/p' })).toThrow(RangeError);
  });
});

describe('methodPicker', () => {
  test('one set_method button per method on offer, nothing else', () => {
    const msg = methodPicker({
      orderNo: 'L-012',
      orderId: ORDER_ID,
      totalSatang: 12000,
      methods: ['cash', 'promptpay', 'gov_copay'],
    });
    expect(msg).toMatchSnapshot();
    const buttons = walk(msg).filter((n) => n.type === 'button');
    expect(buttons.map((b) => parsePostback((b.action as { data: string }).data))).toEqual([
      { action: 'set_method', orderId: ORDER_ID, method: 'cash' },
      { action: 'set_method', orderId: ORDER_ID, method: 'promptpay' },
      { action: 'set_method', orderId: ORDER_ID, method: 'gov_copay' },
    ]);
    expect(JSON.stringify(msg)).not.toMatch(/https?:|image/i);
  });
  test('without gov_copay it is not offered', () => {
    const msg = methodPicker({
      orderNo: 'L-012',
      orderId: ORDER_ID,
      totalSatang: 12000,
      methods: ['cash', 'promptpay'],
    });
    expect(JSON.stringify(msg)).not.toContain('gov_copay');
  });
});

describe('orderStatusCard, menuLink, payInfoCard, receiptCard', () => {
  test('status card snapshot, with the order link', () => {
    const msg = orderStatusCard({
      orderNo: 'L-012',
      orderStatus: 'preparing',
      paymentStatus: 'awaiting_confirmation',
      orderUrl: 'https://liff.line.me/1-a/orders/x',
    });
    expect(msg).toMatchSnapshot();
    expect(allText(msg)).toContain('กำลังทำอาหาร');
    expect(allText(msg)).toContain('รอตรวจสอบ');
  });
  test('menu link snapshot', () => {
    expect(menuLink({ menuUrl: 'https://liff.line.me/1-a/menu' })).toMatchSnapshot();
    expect(() => menuLink({ menuUrl: 'http://x/menu' })).toThrow(RangeError);
  });
  test('the generic pay-info card names co-pay as an option and has no link, image or QR', () => {
    const msg = payInfoCard();
    expect(msg).toMatchSnapshot();
    expect(allText(msg)).toContain('ไทยช่วยไทย');
    expect(JSON.stringify(msg)).not.toMatch(/https?:|image|qr/i);
  });
  test('the receipt card carries items, total and method', () => {
    const msg = receiptCard({
      orderNo: 'L-012',
      building: 'B1',
      items,
      totalSatang: 12000,
      methodLabel: 'เงินสด',
    });
    expect(msg).toMatchSnapshot();
    expect(allText(msg)).toContain('฿120.00');
    expect(allText(msg)).toContain('เงินสด');
  });
});
