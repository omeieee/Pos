import type { MyOrder } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { OrderView, PaidPopup } from './OrderScreen.tsx';

const ID = '0191a8f0-0000-7000-8000-000000000001';

function order(over: Partial<MyOrder>): MyOrder {
  return {
    id: ID,
    orderNo: 'A-001',
    status: 'new',
    paymentStatus: 'awaiting_confirmation',
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
    payment: { id: ID, method: 'promptpay', status: 'claimed', amountSatang: 5000 },
    actions: { claim: false, changeMethod: false, showQr: true, attachSlip: true, methods: [] },
    ...over,
  } as MyOrder;
}

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale: 'th', go: () => {} }}>
      {node}
    </Ctx.Provider>,
  );
}

const render = (o: MyOrder) =>
  wrap(<OrderView order={o} setOrder={() => {}} flag={null} shopPhone={null} />);

describe('slip stage on a claimed PromptPay payment', () => {
  test('none asks for the slip', () => {
    const html = render(order({ slipCheck: 'none' }));
    expect(html).toContain('ส่งสลิปเพื่อยืนยันเร็วขึ้น');
    expect(html).not.toContain('กำลังตรวจสลิป');
  });

  test('checking says the slip is being checked', () => {
    const html = render(order({ hasSlip: true, slipCheck: 'checking' }));
    expect(html).toContain('กำลังตรวจสลิป…');
    expect(html).not.toContain('ส่งสลิปเพื่อยืนยันเร็วขึ้น');
  });

  test('staff_review is neutral and never names a reason', () => {
    const html = render(order({ hasSlip: true, slipCheck: 'staff_review' }));
    expect(html).toContain('ได้รับสลิปแล้ว ร้านกำลังตรวจสอบ');
    expect(html).not.toMatch(/ไม่ผ่าน|ปลอม|ไม่ตรง|ซ้ำ|ผิดพลาด|ยอดไม่/);
  });

  test('amount_mismatch is the one failure that is named', () => {
    const html = render(order({ hasSlip: true, slipCheck: 'amount_mismatch' }));
    expect(html).toContain('ยอดเงินไม่ตรง ร้านกำลังตรวจสอบ');
    expect(html).not.toContain('ได้รับสลิปแล้ว ร้านกำลังตรวจสอบ');
  });

  test('verified_waiting says the slip is valid and the shop is confirming, not paid', () => {
    const html = render(order({ hasSlip: true, slipCheck: 'verified_waiting' }));
    expect(html).toContain('สลิปถูกต้อง ร้านกำลังยืนยัน');
    expect(html).not.toContain('ชำระเงินแล้ว ขอบคุณค่ะ');
  });

  test('without slipCheck the old hint stays and no stage line shows', () => {
    const html = render(order({}));
    expect(html).toContain('ส่งสลิปเพิ่มได้');
    expect(html).not.toContain('กำลังตรวจสลิป');
    expect(html).not.toContain('ได้รับสลิปแล้ว ร้านกำลังตรวจสอบ');
  });
});

describe('paid pop-up', () => {
  test('is a labelled modal dialog with the order number and a close button', () => {
    const html = wrap(<PaidPopup orderNo="A-001" onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="paid-popup-title"');
    expect(html).toContain('ชำระเงินสำเร็จ ✓');
    expect(html).toContain('ร้านได้รับเงินแล้ว');
    expect(html).toContain('A-001');
    expect(html).toContain('ปิด');
  });

  test('an order already paid on first render shows no pop-up', () => {
    const html = render(
      order({
        paymentStatus: 'paid',
        payment: { id: ID, method: 'promptpay', status: 'confirmed', amountSatang: 5000 },
      }),
    );
    expect(html).not.toContain('role="dialog"');
  });
});
