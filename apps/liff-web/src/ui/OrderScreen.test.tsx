import type { MyOrder } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import { awaitsTransferConfirmation } from '../model/steps.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { OrderView } from './OrderScreen.tsx';

const ID = '0191a8f0-0000-7000-8000-000000000001';

function order(over: Partial<MyOrder>): MyOrder {
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
    payment: { id: ID, method: 'promptpay', status: 'rejected', amountSatang: 5000 },
    actions: { claim: true, changeMethod: false, showQr: true, attachSlip: true, methods: [] },
    ...over,
  } as MyOrder;
}

function render(o: MyOrder, shopPhone: string | null) {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale: 'th', go: () => {} }}>
      <OrderView order={o} setOrder={() => {}} flag={null} shopPhone={shopPhone} />
    </Ctx.Provider>,
  );
}

describe('rejected PromptPay payment', () => {
  const html = render(order({ paymentRejected: true }), '0812345678');

  test('shows the not-found warning, never the paid or cash notice', () => {
    expect(html).toContain('ยังไม่พบยอดโอน');
    expect(html).toContain('กรุณาตรวจสอบและโอนใหม่');
    expect(html).not.toContain('จ่ายเงินสดตอนรับอาหาร');
    expect(html).not.toContain('ชำระแล้ว');
  });

  test('QR, claim and slip buttons are back, and the shop phone is linked', () => {
    expect(html).toContain('โอนแล้ว');
    expect(html).toContain('type="file"');
    expect(html).toContain('href="tel:0812345678"');
  });

  test('no warning when the flag is missing or false', () => {
    expect(render(order({ paymentRejected: undefined }), null)).not.toContain('ยังไม่พบยอดโอน');
    expect(render(order({ paymentRejected: false }), null)).not.toContain('ยังไม่พบยอดโอน');
  });

  test('a preparing PromptPay order not yet confirmed shows the waiting label; cash does not', () => {
    const pp = render(
      order({
        status: 'preparing',
        paymentStatus: 'awaiting_confirmation',
        payment: { id: ID, method: 'promptpay', status: 'claimed', amountSatang: 5000 },
      }),
      null,
    );
    expect(pp).toContain('รอร้านยืนยันยอดโอน');
    const cash = render(order({ status: 'preparing', payment: null }), null);
    expect(cash).not.toContain('รอร้านยืนยันยอดโอน');
  });
});

describe('waiting label for an unconfirmed PromptPay transfer', () => {
  const base = { paymentStatus: 'awaiting_confirmation' as const, paymentRejected: false };
  const pp = { method: 'promptpay' } as MyOrder['payment'];

  test('shown while preparing or ready and not paid', () => {
    expect(awaitsTransferConfirmation({ ...base, status: 'preparing', payment: pp })).toBe(true);
    expect(
      awaitsTransferConfirmation({
        ...base,
        status: 'ready',
        paymentStatus: 'unpaid',
        payment: pp,
      }),
    ).toBe(true);
  });

  test('not shown for cash, paid, new, rejected or closed orders', () => {
    const cash = { method: 'cash' } as MyOrder['payment'];
    expect(awaitsTransferConfirmation({ ...base, status: 'preparing', payment: cash })).toBe(false);
    expect(awaitsTransferConfirmation({ ...base, status: 'preparing', payment: null })).toBe(false);
    expect(
      awaitsTransferConfirmation({
        ...base,
        status: 'preparing',
        paymentStatus: 'paid',
        payment: pp,
      }),
    ).toBe(false);
    expect(awaitsTransferConfirmation({ ...base, status: 'new', payment: pp })).toBe(false);
    expect(
      awaitsTransferConfirmation({
        ...base,
        status: 'preparing',
        paymentRejected: true,
        payment: pp,
      }),
    ).toBe(false);
    expect(awaitsTransferConfirmation({ ...base, status: 'completed', payment: pp })).toBe(false);
  });
});
