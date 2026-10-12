import { t } from '@sds/i18n';
import type { MyOrder } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { type Api, ApiFailure } from '../api/client.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx, cooldownMinutes, errorKey, errorText } from './app-context.tsx';
import { OrderView } from './OrderScreen.tsx';

const ID = '0191a8f0-0000-7000-8000-000000000001';

function order(over: Partial<MyOrder>, attachSlip = true): MyOrder {
  return {
    id: ID,
    orderNo: 'A-001',
    status: 'new',
    paymentStatus: 'unpaid',
    subtotalSatang: 5000,
    totalSatang: 5000,
    items: [],
    deliveryBuilding: null,
    recipientName: null,
    deliveryNote: null,
    note: null,
    placedAt: '2026-10-11T03:00:00.000Z',
    readyAt: null,
    completedAt: null,
    cancelledAt: null,
    payment: { id: ID, method: 'promptpay', status: 'pending', amountSatang: 5000 },
    actions: { claim: true, changeMethod: false, showQr: true, attachSlip, methods: [] },
    ...over,
  } as MyOrder;
}

function render(o: MyOrder) {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale: 'th', go: () => {} }}>
      <OrderView order={o} setOrder={() => {}} flag={null} shopPhone={null} />
    </Ctx.Provider>,
  );
}

describe('slip cooldown', () => {
  const html = render(order({ slipRetryAfterSeconds: 125 }));

  test('shows the wait in whole minutes, rounded up, and disables the slip button', () => {
    expect(html).toContain('ส่งสลิปบ่อยเกินไป กรุณารอ 3 นาทีแล้วส่งใหม่');
    expect(html).not.toContain('type="file"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?แนบสลิป/);
  });

  test('the claim button still works', () => {
    expect(html).toContain('โอนแล้ว');
  });

  test('no notice and a working upload when there is no cooldown', () => {
    const free = render(order({}));
    expect(free).not.toContain('ส่งสลิปบ่อยเกินไป');
    expect(free).toContain('type="file"');
  });
});

describe('slip blocked', () => {
  const html = render(order({ slipBlocked: true }, false));

  test('shows the neutral text, no upload, claim still present', () => {
    expect(html).toContain('ออเดอร์นี้ส่งสลิปไม่ได้ กรุณากด โอนแล้ว แล้วพนักงานจะตรวจสอบกับธนาคาร');
    expect(html).not.toContain('type="file"');
    expect(html).toContain('โอนแล้ว');
  });

  test('never gives a reason', () => {
    expect(html).not.toMatch(/ปลอม|โกง|สงสัย|fake|fraud/i);
    expect(t('en', 'liff.error.SLIP_BLOCKED')).not.toMatch(/fake|fraud|suspic/i);
  });
});

describe('error mapping', () => {
  const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) =>
    t('th', key, params);

  test('both codes map to their own keys', () => {
    expect(errorKey(new ApiFailure(429, 'SLIP_COOLDOWN', [], 90))).toBe('liff.error.SLIP_COOLDOWN');
    expect(errorKey(new ApiFailure(409, 'SLIP_BLOCKED'))).toBe('liff.error.SLIP_BLOCKED');
  });

  test('the cooldown message carries the rounded-up minutes', () => {
    expect(errorText(tr, new ApiFailure(429, 'SLIP_COOLDOWN', [], 90))).toBe(
      'ส่งสลิปบ่อยเกินไป กรุณารอ 2 นาทีแล้วส่งใหม่',
    );
    expect(cooldownMinutes(1)).toBe(1);
    expect(cooldownMinutes(60)).toBe(1);
    expect(cooldownMinutes(61)).toBe(2);
  });

  test('other errors pass through unchanged', () => {
    expect(errorText(tr, new ApiFailure(409, 'SLIP_BLOCKED'))).toBe(
      t('th', 'liff.error.SLIP_BLOCKED'),
    );
  });
});
