import type { AppOpenOrder, MyOrder } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import { checkoutWarning } from '../model/open-orders.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { OrderView } from './OrderScreen.tsx';
import { CancelSheet, CombineSheet, MismatchSheet, OpenOrderSheet } from './order/sheets.tsx';

const ID = '0191a8f0-0000-7000-8000-000000000001';

function order(over: Partial<MyOrder>): MyOrder {
  return {
    id: ID,
    orderNo: 'L-001',
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
    cancelReason: null,
    mergedInto: null,
    payment: { id: ID, method: 'promptpay', status: 'pending', amountSatang: 5000 },
    actions: {
      claim: true,
      changeMethod: true,
      showQr: true,
      attachSlip: true,
      methods: [],
      edit: true,
      cancel: true,
    },
    ...over,
  } as MyOrder;
}

function wrap(node: React.ReactNode, locale: 'th' | 'en' = 'th') {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale, go: () => {} }}>
      {node}
    </Ctx.Provider>,
  );
}

const view = (o: MyOrder, onEdit?: (o: AppOpenOrder) => void) =>
  wrap(
    <OrderView
      order={o}
      setOrder={() => {}}
      flag={null}
      shopPhone={null}
      {...(onEdit ? { onEdit } : {})}
    />,
  );

describe('edit and cancel buttons on the order page', () => {
  test('shown only when the server allows them', () => {
    const both = view(order({}), () => {});
    expect(both).toContain('แก้ไขรายการ');
    expect(both).toContain('ยกเลิกออเดอร์');
    const none = view(
      order({
        actions: {
          claim: true,
          changeMethod: true,
          showQr: true,
          attachSlip: true,
          methods: [],
          edit: false,
          cancel: false,
        },
      }),
      () => {},
    );
    expect(none).not.toContain('แก้ไขรายการ');
    expect(none).not.toContain('ยกเลิกออเดอร์');
  });

  test('a paid order offers neither', () => {
    const html = view(order({ paymentStatus: 'paid' }), () => {});
    expect(html).not.toContain('แก้ไขรายการ');
    expect(html).not.toContain('ยกเลิกออเดอร์');
  });
});

describe('cancelled orders say why in plain words', () => {
  const cancelled = (over: Partial<MyOrder>) =>
    view(order({ status: 'cancelled', cancelledAt: '2026-10-11T04:00:00.000Z', ...over }));

  test('unpaid timeout', () => {
    expect(cancelled({ cancelReason: 'unpaid_timeout' })).toContain(
      'ไม่ได้ชำระภายใน 1 ชั่วโมง ระบบยกเลิกให้อัตโนมัติ',
    );
  });
  test('cancelled by the customer', () => {
    expect(cancelled({ cancelReason: 'customer_cancel' })).toContain('ยกเลิกโดยคุณ');
  });
  test('merged names the surviving order', () => {
    expect(cancelled({ cancelReason: 'merged', mergedInto: 'L-004' })).toContain(
      'รวมเข้ากับออเดอร์ #L-004',
    );
  });
  test('no reason, no extra line', () => {
    expect(cancelled({ cancelReason: null })).not.toContain('cancel-reason');
    expect(cancelled({ cancelReason: 'other' })).not.toContain('cancel-reason');
  });
});

describe('question sheets', () => {
  test('cancel', () => {
    const html = wrap(
      <CancelSheet orderNo="L-001" busy={false} onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('ยกเลิกออเดอร์ #L-001?');
    expect(html).toContain('ยืนยันยกเลิก');
    expect(html).toContain('ไม่ยกเลิก');
  });

  test('combine names the amount and both orders', () => {
    const html = wrap(
      <CombineSheet
        totalSatang={10_000}
        orderNos={['L-001', 'L-002']}
        busy={false}
        onYes={() => {}}
        onNo={() => {}}
      />,
    );
    expect(html).toContain('ยอดโอน ฿100.00 ตรงกับออเดอร์ #L-001 + #L-002 รวมออเดอร์ไหม?');
    expect(html).toContain('รวมออเดอร์');
  });

  test('mismatch offers send-to-the-shop and a new slip', () => {
    const html = wrap(
      <MismatchSheet busy={false} onReview={() => {}} onPick={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('ยอดเงินไม่ตรง');
    expect(html).toContain('ส่งให้ร้านตรวจ');
    expect(html).toContain('เลือกสลิปใหม่');
    expect(html).toContain('type="file"');
  });
});

describe('open-order sheet', () => {
  const DISH = '0191a8f0-0000-7000-8000-000000000002';
  const open: AppOpenOrder = {
    id: ID,
    orderNo: 'L-001',
    totalSatang: 5000,
    version: 1,
    businessDate: '2026-10-11',
    deliveryBuilding: 'A1',
    recipientName: 'คุณตัวอย่าง',
    placedAt: '2026-10-11T03:00:00.000Z',
    items: [{ menuItemId: DISH, nameTh: 'จาน', nameEn: null, qty: 1, modifierOptionIds: [] }],
  };
  const sheet = (cartDish: string, step: 'ask' | 'choose') => {
    const warning = checkoutWarning(
      [open],
      [{ key: 'k', menuItemId: cartDish, qty: 1, optionIds: [], note: '' }],
      { building: 'A1', name: 'คุณตัวอย่าง' },
    );
    if (!warning) throw new Error('no warning');
    return wrap(
      <OpenOrderSheet
        step={step}
        warning={warning}
        busy={false}
        onContinue={() => {}}
        onView={() => {}}
        onMerge={() => {}}
        onSeparate={() => {}}
        onClose={() => {}}
      />,
    );
  };

  test('step one asks, in the strong wording only for the same dishes', () => {
    const other = sheet('0191a8f0-0000-7000-8000-000000000009', 'ask');
    expect(other).toContain('คุณมีออเดอร์ที่ยังไม่ชำระ #L-001 (฿50.00) ต้องการสั่งต่อไหม?');
    expect(other).toContain('สั่งต่อ');
    const same = sheet(DISH, 'ask');
    expect(same).toContain('เป็นรายการเดียวกับที่กำลังสั่ง');
    expect(same).not.toContain('ต้องการสั่งต่อไหม?');
  });

  test('step two offers to merge or to keep them apart', () => {
    const html = sheet('0191a8f0-0000-7000-8000-000000000009', 'choose');
    expect(html).toContain('รวมกับออเดอร์เดิม');
    expect(html).toContain('แยกเป็นออเดอร์ใหม่');
  });
});
