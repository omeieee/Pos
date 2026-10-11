// @vitest-environment jsdom
import { catalogs, formatBaht } from '@sds/i18n';
import { type OrderDto, type StaffRole, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { MemberLine } from './MemberLine.tsx';
import { newRefunds, OrderCorrectionActions } from './OrderCorrection.tsx';

const th = catalogs.th;
const ID = uuid(900);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const line = (n: number, qty: number, name: string) => ({
  id: uuid(n),
  menuItemId: uuid(n + 100),
  nameTh: name,
  nameEn: null,
  unitPriceSatang: satang(5000),
  qty,
  modifiers: [],
  note: null,
  lineTotalSatang: satang(5000 * qty),
});

const pastOrder = (over: Partial<OrderDto> = {}) =>
  orderDto(ID, 40, {
    orderNo: 'S-007',
    status: 'completed',
    paymentStatus: 'paid',
    version: 9,
    totalSatang: satang(15000),
    items: [line(1, 2, 'ก๋วยเตี๋ยวหมู'), line(2, 1, 'ก๋วยเตี๋ยวไก่')],
    ...over,
  });

async function setup(
  role: StaffRole,
  order: OrderDto,
  orders: Parameters<typeof createTestServices>[0] = {},
) {
  const { auth } = await createTestAuth(role);
  // A fresh step-up, so the sheet does not stop at the dialog.
  if (role === 'owner') {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', code: '1' } as never });
  }
  const env = createTestServices({ auth, ...orders });
  env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
  if (!orders.payments?.list) env.payments.refresh = vi.fn(async () => undefined);
  renderScreen(<OrderCorrectionActions order={order} />, env.services);
  return { ...env, auth };
}

const button = (name: string) => screen.getByRole('button', { name });

describe('who sees the actions', () => {
  test.each(['manager', 'cashier', 'kitchen'] as const)('%s sees neither button', async (role) => {
    await setup(role, pastOrder());
    expect(screen.queryByRole('button', { name: th['order.fix.edit'] })).toBeNull();
    expect(screen.queryByRole('button', { name: th['order.fix.void'] })).toBeNull();
  });

  test('the owner sees both on a completed, paid order, but not on a voided one', async () => {
    await setup('owner', pastOrder());
    expect(button(th['order.fix.edit'])).toBeTruthy();
    expect(button(th['order.fix.void'])).toBeTruthy();
    cleanup();
    await setup('owner', pastOrder({ status: 'cancelled' }));
    expect(screen.queryByRole('button', { name: th['order.fix.edit'] })).toBeNull();
  });
});

describe('the edit sheet', () => {
  test('sends the changed quantity with the version and a reason, and shows what the server answers', async () => {
    const answer = pastOrder({ version: 10, rev: 41, totalSatang: satang(20000) });
    const correct = vi.fn(async () => answer);
    const env = await setup('owner', pastOrder(), { orders: { correct } });
    fireEvent.click(button(th['order.fix.edit']));
    const dialog = screen.getByRole('dialog');
    // The money consequence is stated before anything is sent.
    expect(within(dialog).getByText(th['order.fix.afterEdit'])).toBeTruthy();
    const save = within(dialog).getByRole('button', { name: th['order.fix.save'] });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['order.fix.qtyUp'].replace('{name}', 'ก๋วยเตี๋ยวไก่'),
      }),
    );
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.reason']), {
      target: { value: 'ลูกค้าเพิ่มจาน' },
    });
    // Still blocked: a paid order needs the money consequence to be acknowledged.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: th['order.fix.understand'] }));
    fireEvent.click(save);

    await waitFor(() => expect(correct).toHaveBeenCalledTimes(1));
    expect(correct).toHaveBeenCalledWith(ID, {
      expectedVersion: 9,
      reason: 'ลูกค้าเพิ่มจาน',
      items: [
        { orderItemId: uuid(1), qty: 2, note: null },
        { orderItemId: uuid(2), qty: 2, note: null },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.entities.getState().orders.get(ID)?.totalSatang).toBe(20000);
  });

  test('a refused save keeps the sheet open with the Thai message for PAYMENT_ACTION_REQUIRED', async () => {
    const correct = vi.fn(async () => {
      throw new ApiClientError('PAYMENT_ACTION_REQUIRED', { status: 409 });
    });
    await setup('owner', pastOrder(), { orders: { correct } });
    fireEvent.click(button(th['order.fix.edit']));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['order.fix.remove'].replace('{name}', 'ก๋วยเตี๋ยวไก่'),
      }),
    );
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.reason']), {
      target: { value: 'ลบจาน' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: th['order.fix.understand'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.fix.save'] }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(th['error.paymentActionRequired']);
    // The choice is offered, the sheet is still there, and nothing is closed behind the owner's back.
    expect(
      within(dialog).getByRole('radio', { name: th['payment.void.kind.refund'] }),
    ).toBeTruthy();
  });

  test('an unpaid order shows no payment choice and no acknowledgement', async () => {
    await setup('owner', pastOrder({ paymentStatus: 'unpaid' }));
    fireEvent.click(button(th['order.fix.edit']));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  test('without a fresh step-up the dialog asks first and the call waits', async () => {
    const correct = vi.fn(async () => pastOrder({ version: 10, rev: 41 }));
    const { auth } = await createTestAuth('owner');
    const env = createTestServices({ auth, orders: { correct } });
    const order = pastOrder({ paymentStatus: 'unpaid' });
    env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
    renderScreen(<OrderCorrectionActions order={order} />, env.services);
    fireEvent.click(button(th['order.fix.edit']));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['order.fix.qtyDown'].replace('{name}', 'ก๋วยเตี๋ยวหมู'),
      }),
    );
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.reason']), {
      target: { value: 'ลดจาน' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.fix.save'] }));
    await waitFor(() => expect(auth.getState().stepUpOpen).toBe(true));
    expect(correct).not.toHaveBeenCalled();
  });
});

describe('what the owner hands back after an adjusted payment', () => {
  const refundRow = (n: number, amountSatang: number, method: 'cash' | 'promptpay') => ({
    id: uuid(700 + n),
    paymentId: uuid(600 + n),
    amountSatang: satang(amountSatang),
    method,
    referenceNote: null,
    reason: 'แก้ไขออเดอร์',
    refundedAt: '2030-10-15T05:00:00.000Z',
  });
  const ledgerAnswer = (refunds: ReturnType<typeof refundRow>[]) => ({
    payments: [],
    refunds,
    netPaidSatang: satang(10000),
    dueSatang: satang(0),
  });

  /** Opens the edit sheet, adjusts the payment down, picks the refund method and saves. */
  async function adjustDown(list: ReturnType<typeof vi.fn>) {
    const answer = pastOrder({ version: 10, rev: 41, totalSatang: satang(10000) });
    let calls = 0;
    const correct = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new ApiClientError('REFUND_DETAILS_REQUIRED', { status: 409 });
      return answer;
    });
    const env = await setup('owner', pastOrder(), {
      orders: { correct, get: async () => answer },
      payments: { list },
    } as never);
    await env.payments.refresh(ID);
    fireEvent.click(button(th['order.fix.edit']));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['order.fix.remove'].replace('{name}', 'ก๋วยเตี๋ยวไก่'),
      }),
    );
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.reason']), {
      target: { value: 'ลบจาน' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: th['payment.void.kind.adjust'] }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: th['order.fix.understand'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.fix.save'] }));
    await within(dialog).findByTestId('refund-choice');
    fireEvent.click(within(dialog).getByRole('radio', { name: th['order.fix.refund.cash'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.fix.save'] }));
  }

  test('a refund spread over two payments lists each new row with its own amount and method', async () => {
    const old = refundRow(1, 1111, 'cash');
    const list = vi
      .fn()
      .mockResolvedValueOnce(ledgerAnswer([old]))
      .mockResolvedValue(
        ledgerAnswer([old, refundRow(2, 3000, 'cash'), refundRow(3, 2000, 'promptpay')]),
      );
    await adjustDown(list);
    const done = await screen.findByRole('status');
    const text = done.textContent ?? '';
    expect(text).toContain(
      th['order.fix.done.refund']
        .replace('{amount}', formatBaht(3000, 'th'))
        .replace('{method}', th['payment.method.cash']),
    );
    expect(text).toContain(
      th['order.fix.done.refund']
        .replace('{amount}', formatBaht(2000, 'th'))
        .replace('{method}', th['payment.method.promptpay']),
    );
    // The older refund is not listed, and nothing is added up.
    expect(text).not.toContain(formatBaht(1111, 'th'));
    expect(text).not.toContain(formatBaht(5000, 'th'));
  });

  test('a ledger that did not change shows no number, only where to look', async () => {
    const list = vi.fn().mockResolvedValue(ledgerAnswer([refundRow(1, 1111, 'cash')]));
    await adjustDown(list);
    const done = await screen.findByRole('status');
    expect(done.textContent).toBe(th['order.fix.done.refundNoAmount']);
  });

  test('a failed ledger refresh shows no number either', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(ledgerAnswer([refundRow(1, 1111, 'cash')]))
      .mockRejectedValue(new ApiClientError('NETWORK', { status: 0 }));
    await adjustDown(list);
    const done = await screen.findByRole('status');
    expect(done.textContent).toBe(th['order.fix.done.refundNoAmount']);
  });

  test('newRefunds: rows by id, and nothing can be told without a ledger from before', () => {
    const a = refundRow(1, 100, 'cash');
    const b = refundRow(2, 200, 'promptpay');
    expect(newRefunds([a], [a, b])).toEqual([b]);
    expect(newRefunds([a], [a])).toEqual([]);
    expect(newRefunds(undefined, [a, b])).toBeNull();
    expect(newRefunds([a], undefined)).toBeNull();
  });
});

describe('the void sheet', () => {
  test('a paid order needs a reason, the void/refund choice and the acknowledgement', async () => {
    const void_ = vi.fn(async () => pastOrder({ status: 'cancelled', version: 10, rev: 41 }));
    const env = await setup('owner', pastOrder(), { orders: { void: void_ } });
    fireEvent.click(button(th['order.fix.void']));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(th['order.fix.afterVoid'])).toBeTruthy();
    const confirm = within(dialog).getByRole('button', {
      name: th['order.fix.voidConfirm'],
    }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.voidReason']), {
      target: { value: 'ลูกค้ายกเลิก' },
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: th['payment.void.kind.refund'] }));
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: th['order.fix.understand'] }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(void_).toHaveBeenCalledTimes(1));
    const [id, input] = void_.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe(ID);
    expect(input).toMatchObject({
      reason: 'ลูกค้ายกเลิก',
      expectedVersion: 9,
      paymentAction: 'refund',
    });
    expect(typeof input.clientRequestId).toBe('string');
    await waitFor(() => expect(env.entities.getState().orders.get(ID)?.status).toBe('cancelled'));
  });

  test('an unpaid order needs only a reason', async () => {
    const void_ = vi.fn(async () => pastOrder({ status: 'cancelled', version: 10, rev: 41 }));
    await setup('owner', pastOrder({ paymentStatus: 'unpaid' }), { orders: { void: void_ } });
    fireEvent.click(button(th['order.fix.void']));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(th['order.fix.voidReason']), {
      target: { value: 'ซ้ำ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.fix.voidConfirm'] }));
    await waitFor(() => expect(void_).toHaveBeenCalledTimes(1));
    expect((void_.mock.calls[0] as unknown as unknown[])[1]).not.toHaveProperty('paymentAction');
  });
});

describe('the member line', () => {
  const member = {
    fullName: 'สมมติ ตัวอย่าง',
    nickname: 'ตัวอย่าง',
    building: 'อาคาร ทดสอบ',
    phone: '0800000000',
  };

  async function show(role: StaffRole, value: typeof member | null) {
    const { auth } = await createTestAuth(role);
    const env = createTestServices({ auth });
    renderScreen(<MemberLine member={value} />, env.services);
  }

  test('shows who the order is for to the kitchen, without the phone', async () => {
    await show('kitchen', member);
    const view = screen.getByTestId('member-line');
    expect(view.textContent).toContain('ตัวอย่าง · สมมติ ตัวอย่าง · อาคาร ทดสอบ');
    expect(view.textContent).not.toContain('0800000000');
  });

  test('shows the phone to a cashier', async () => {
    await show('cashier', member);
    expect(screen.getByTestId('member-line').textContent).toContain('0800000000');
  });

  test('shows nothing when the customer gave nothing', async () => {
    await show('cashier', null);
    expect(screen.queryByTestId('member-line')).toBeNull();
  });
});
