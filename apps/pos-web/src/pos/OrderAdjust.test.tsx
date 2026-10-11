// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { type OrderDto, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderCorrectionActions } from './OrderCorrection.tsx';

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

const refundRow = {
  id: uuid(70),
  paymentId: uuid(500),
  amountSatang: satang(5000),
  method: 'cash' as const,
  referenceNote: null,
  reason: 'ลดจาน',
  refundedAt: '2030-10-15T05:00:00.000Z',
};

async function open(
  order: OrderDto,
  orders: Record<string, unknown>,
  list?: () => Promise<unknown>,
  which: 'edit' | 'void' = 'edit',
) {
  const { auth } = await createTestAuth('owner');
  await auth.submitStepUp({ method: 'owner', factors: { password: 'x', code: '1' } as never });
  const env = createTestServices({
    auth,
    orders: orders as never,
    ...(list ? { payments: { list } as never } : {}),
  });
  env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
  renderScreen(<OrderCorrectionActions order={order} />, env.services);
  fireEvent.click(screen.getByRole('button', { name: th[`order.fix.${which}`] }));
  return { ...env, dialog: screen.getByRole('dialog') };
}

function changeAndExplain(dialog: HTMLElement) {
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: th['order.fix.qtyDown'].replace('{name}', 'ก๋วยเตี๋ยวหมู'),
    }),
  );
  fireEvent.change(within(dialog).getByLabelText(th['order.fix.reason']), {
    target: { value: 'ลดจาน' },
  });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: th['order.fix.understand'] }));
}

const choice = (dialog: HTMLElement, key: 'adjust' | 'void' | 'refund') =>
  within(dialog).getByRole('radio', { name: th[`payment.void.kind.${key}`] }) as HTMLInputElement;
const save = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: th['order.fix.save'] }) as HTMLButtonElement;
const bodyOf = (fn: ReturnType<typeof vi.fn>, call = 0) =>
  (fn.mock.calls[call] as unknown as [string, Record<string, unknown>])[1];

describe('the edit sheet offers adjust', () => {
  test('a confirmed payment offers adjust first and preselects nothing', async () => {
    const { dialog } = await open(pastOrder(), { correct: vi.fn() });
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false, false]);
    expect(radios[0]).toBe(choice(dialog, 'adjust'));
    expect(choice(dialog, 'adjust').disabled).toBe(false);
  });

  test('a claimed payment preselects void and switches adjust off with the reason', async () => {
    const { dialog } = await open(pastOrder({ paymentStatus: 'awaiting_confirmation' }), {
      correct: vi.fn(),
    });
    expect(choice(dialog, 'void').checked).toBe(true);
    expect(choice(dialog, 'adjust').disabled).toBe(true);
    expect(within(dialog).getByText(th['order.fix.adjust.claimedFirst'])).toBeTruthy();
  });

  test('adjust sends paymentAction adjust with no refund and no amount', async () => {
    const correct = vi.fn(async () => pastOrder({ version: 10, rev: 41 }));
    const { dialog } = await open(pastOrder(), { correct });
    fireEvent.click(choice(dialog, 'adjust'));
    expect(within(dialog).getByText(th['order.fix.adjust.explain'])).toBeTruthy();
    changeAndExplain(dialog);
    fireEvent.click(save(dialog));
    await waitFor(() => expect(correct).toHaveBeenCalledTimes(1));
    const body = bodyOf(correct);
    expect(body.paymentAction).toBe('adjust');
    expect(body).not.toHaveProperty('refund');
    expect(JSON.stringify(body)).not.toMatch(/amount/i);
  });

  test('when the server says the total is lower, the refund method is asked and then sent', async () => {
    const correct = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('REFUND_DETAILS_REQUIRED', { status: 422 }))
      .mockResolvedValueOnce(pastOrder({ version: 10, rev: 41, totalSatang: satang(10000) }));
    const answer = (refunds: (typeof refundRow)[]) => ({
      payments: [],
      refunds,
      netPaidSatang: satang(10000),
      dueSatang: satang(0),
    });
    // The payment screen has read the ledger before the owner saves (no refund yet), so the new row is told apart.
    const list = vi
      .fn()
      .mockResolvedValueOnce(answer([]))
      .mockResolvedValue(answer([refundRow]));
    const { dialog, payments } = await open(pastOrder(), { correct }, list);
    await payments.refresh(pastOrder().id);
    fireEvent.click(choice(dialog, 'adjust'));
    changeAndExplain(dialog);
    expect(within(dialog).queryByTestId('refund-choice')).toBeNull();
    fireEvent.click(save(dialog));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      th['error.refundDetailsRequired'],
    );
    const picker = within(dialog).getByTestId('refund-choice');
    expect(save(dialog).disabled).toBe(true);
    fireEvent.click(within(picker).getByRole('radio', { name: th['order.fix.refund.promptpay'] }));
    fireEvent.change(within(picker).getByLabelText(th['order.fix.refund.reference']), {
      target: { value: ' ref 123 ' },
    });
    fireEvent.click(save(dialog));
    await waitFor(() => expect(correct).toHaveBeenCalledTimes(2));
    expect(bodyOf(correct, 1).refund).toEqual({ method: 'promptpay', referenceNote: 'ref 123' });
    // The result shows the server's refund row, not a figure worked out here.
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('฿50.00');
  });

  test('a higher total: the sheet states the server due and takes staff to payment', async () => {
    const correct = vi.fn(async () =>
      pastOrder({
        version: 10,
        rev: 41,
        totalSatang: satang(20000),
        paymentStatus: 'partially_paid',
      }),
    );
    const list = vi.fn(async () => ({
      payments: [],
      refunds: [],
      netPaidSatang: satang(15000),
      dueSatang: satang(5000),
    }));
    const { dialog } = await open(pastOrder(), { correct }, list);
    fireEvent.click(choice(dialog, 'adjust'));
    changeAndExplain(dialog);
    fireEvent.click(save(dialog));
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('฿50.00');
    const heading = document.createElement('h2');
    heading.id = 'pay-title';
    heading.tabIndex = -1;
    heading.scrollIntoView = vi.fn();
    document.body.appendChild(heading);
    fireEvent.click(screen.getByRole('button', { name: th['order.fix.done.goPay'] }));
    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole('dialog')).toBeNull();
    heading.remove();
  });

  test('REFUND_NOT_NEEDED hides the picker again', async () => {
    const correct = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('REFUND_DETAILS_REQUIRED', { status: 422 }))
      .mockRejectedValueOnce(new ApiClientError('REFUND_NOT_NEEDED', { status: 422 }));
    const { dialog } = await open(pastOrder(), { correct });
    fireEvent.click(choice(dialog, 'adjust'));
    changeAndExplain(dialog);
    fireEvent.click(save(dialog));
    await within(dialog).findByTestId('refund-choice');
    fireEvent.click(within(dialog).getByRole('radio', { name: th['order.fix.refund.cash'] }));
    fireEvent.click(save(dialog));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe(th['error.refundNotNeeded']),
    );
    expect(within(dialog).queryByTestId('refund-choice')).toBeNull();
  });
});

describe('the void sheet default', () => {
  test('a claimed payment preselects void and has no adjust', async () => {
    const { dialog } = await open(
      pastOrder({ paymentStatus: 'awaiting_confirmation' }),
      {},
      undefined,
      'void',
    );
    expect(choice(dialog, 'void').checked).toBe(true);
    expect(
      within(dialog).queryByRole('radio', { name: th['payment.void.kind.adjust'] }),
    ).toBeNull();
  });

  test('a confirmed payment preselects nothing', async () => {
    const { dialog } = await open(pastOrder(), {}, undefined, 'void');
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.some((r) => r.checked)).toBe(false);
  });
});
