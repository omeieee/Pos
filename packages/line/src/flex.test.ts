import { describe, expect, test } from 'vitest';
import {
  type FlexNode,
  followGreeting,
  orderConfirmation,
  paymentInstructions,
  readyWithReceipt,
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

  test('promptpay: QR image, ID and exact amount in the text, paid and change buttons', () => {
    const msg = paymentInstructions({
      ...common,
      method: 'promptpay',
      promptpayId: '0812345678',
      qrImageUrl: 'https://api.example.test/v1/payments/x/qr.png?exp=1&sig=abc',
    });
    expect(msg).toMatchSnapshot();
    expect(allText(msg)).toContain('0812345678');
    expect(allText(msg)).toContain('฿120.50');
    const images = walk(msg).filter((n) => n.type === 'image');
    expect(images).toHaveLength(1);
    const buttons = walk(msg).filter((n) => n.type === 'button');
    const actions = buttons.map((b) => parsePostback((b.action as { data: string }).data));
    expect(actions).toEqual([
      { action: 'paid', orderId: ORDER_ID },
      { action: 'change_method', orderId: ORDER_ID },
    ]);
  });

  test('promptpay refuses a non-https image URL', () => {
    expect(() =>
      paymentInstructions({
        ...common,
        method: 'promptpay',
        promptpayId: '0812345678',
        qrImageUrl: 'http://x/qr.png',
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
