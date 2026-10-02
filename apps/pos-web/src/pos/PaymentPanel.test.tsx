// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { type OrderDto, type PaymentDto, type StaffRole, satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import {
  orderDto,
  orderFrame,
  paymentDto,
  paymentFrame,
  paymentMethodsFrame,
  uuid,
} from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

const th = catalogs.th;
const en = catalogs.en;

/** 12:00 in Bangkok on 15 Oct 2030, inside the test co-pay scheme (1 Oct - 30 Nov 2030). */
const NOON = new Date('2030-10-15T05:00:00Z');
const ORDER = uuid(900);
const PAYMENT = uuid(500);
const TOTAL = satang(7500);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const orderOf = (over: Partial<OrderDto> = {}, rev = 10) =>
  orderDto(ORDER, rev, { totalSatang: TOTAL, orderNo: 'S-013', ...over });
const paymentOf = (over: Partial<PaymentDto> = {}, rev = 100) =>
  paymentDto(PAYMENT, ORDER, rev, { amountSatang: TOTAL, ...over });

const created = (payment: PaymentDto, order: OrderDto) => ({
  result: { payment, order },
  replay: false,
  clientRequestId: uuid(1),
});

interface SetupOptions {
  role?: StaffRole;
  order?: OrderDto;
  payments?: PaymentDto[];
  frames?: Parameters<ReturnType<typeof createTestServices>['entities']['apply']>[0][];
  api?: Partial<ApiClient['payments']>;
  list?: PaymentDto[];
}

async function setup(options: SetupOptions = {}) {
  const { auth } = await createTestAuth(options.role ?? 'cashier');
  const env = createTestServices({
    auth,
    payments: {
      list: async () => ({ payments: options.list ?? options.payments ?? [] }),
      ...(options.api ?? {}),
    },
  });
  const order = options.order ?? orderOf();
  env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
  for (const p of options.payments ?? []) {
    env.entities.apply({ type: 'payment.upserted', id: p.id, rev: p.rev, data: p });
  }
  for (const frame of options.frames ?? []) env.entities.apply(frame);
  return env;
}

const key = (name: string) => screen.getByRole('button', { name });
const press = (...keys: string[]) => {
  for (const k of keys) fireEvent.click(key(k));
};
const methodTile = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });

/** Waits until the first load of the payments has finished. */
const loaded = () => waitFor(() => expect(screen.queryByText(th['payment.loading'])).toBeNull());

describe('the payment panel: before anything is paid', () => {
  test('shows the SERVER total as the amount due, and the methods on offer', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.amountDue'])).toBeTruthy();
    expect(screen.getAllByText('฿75.00').length).toBeGreaterThan(0);
    expect(methodTile(th['payment.method.cash'])).toBeTruthy();
    expect(methodTile(th['payment.method.promptpay'])).toBeTruthy();
    expect(methodTile(th['payment.method.gov_copay'])).toBeTruthy();
    // Choosing a method only selects it: nothing is sent.
    expect(env.api.payments.create).not.toHaveBeenCalled();
  });

  test('loads the order’s payments first, and says so meanwhile', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    expect(screen.getByText(th['payment.loading'])).toBeTruthy();
    await loaded();
    expect(env.api.payments.list).toHaveBeenCalledWith(ORDER);
  });

  test('a cancelled order cannot be paid', async () => {
    const env = await setup({ order: orderOf({ status: 'cancelled' }) });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.closed'])).toBeTruthy();
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
  });

  test('an order with nothing to pay says so', async () => {
    const env = await setup({ order: orderOf({ totalSatang: satang(0) }) });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.nothingToPay'])).toBeTruthy();
  });

  test('a method the owner switched off is not offered', async () => {
    const env = await setup({ frames: [paymentMethodsFrame(5, { cash: false })] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
    expect(methodTile(th['payment.method.promptpay'])).toBeTruthy();
  });
});

describe('cash', () => {
  async function cashPanel(api: SetupOptions['api'] = {}) {
    const env = await setup({ api });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.cash']));
    return env;
  }
  const confirmButton = () =>
    screen.getByRole('button', { name: /ยืนยันรับเงิน/ }) as HTMLButtonElement;

  test('the keypad builds the tender; change comes from the shared calculation', async () => {
    await cashPanel();
    expect(confirmButton().disabled).toBe(true);
    press('5', '00');
    expect(screen.getByText('฿500.00', { selector: 'output' })).toBeTruthy();
    expect(screen.getByText('฿425.00')).toBeTruthy();
    expect(confirmButton().textContent).toContain('฿75.00');
    expect(confirmButton().textContent).toContain('฿425.00');
    expect(confirmButton().disabled).toBe(false);
  });

  test('a tender below the total blocks confirming and says how much is still due', async () => {
    const env = await cashPanel();
    press('5', '0');
    expect(screen.getByText(`ยังขาดอีก ฿25.00`)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(env.api.payments.create).not.toHaveBeenCalled();
  });

  test('quick-tender chips come from the shared suggestion, and "exact" is the total', async () => {
    await cashPanel();
    // ฿75: exact, then ฿80, ฿100, ฿500, ฿1,000.
    for (const label of ['พอดี', '฿80', '฿100', '฿500', '฿1,000']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    expect(screen.getByText('฿25.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'พอดี' }));
    expect(screen.getByText('฿75.00', { selector: 'output' })).toBeTruthy();
    expect(confirmButton().textContent).not.toContain('ทอน');
  });

  test('backspace and clear edit the tender', async () => {
    await cashPanel();
    press('1', '2', '3');
    fireEvent.click(screen.getByRole('button', { name: th['payment.cash.backspace'] }));
    expect(screen.getByText('฿12.00', { selector: 'output' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: th['payment.cash.clear'] }));
    expect(screen.queryByText('฿12.00', { selector: 'output' })).toBeNull();
  });

  test('confirming sends the method and the tender, never an amount, and the order shows paid', async () => {
    const paid = orderOf({ paymentStatus: 'paid', status: 'preparing' }, 11);
    const env = await cashPanel({
      create: async () =>
        created(
          paymentOf({
            status: 'confirmed',
            tenderedSatang: satang(10000),
            changeSatang: satang(2500),
          }),
          paid,
        ),
    });
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    const [orderId, input, options] = env.api.payments.create.mock.calls[0] ?? [];
    expect(orderId).toBe(ORDER);
    expect(input).toEqual({ method: 'cash', tendered: 10000 });
    expect(options?.clientRequestId).toBeTruthy();
    expect(JSON.stringify(input)).not.toMatch(/amount|total/i);
    expect(env.entities.getState().orders.get(ORDER)?.paymentStatus).toBe('paid');
  });

  test('nothing says paid until the server has answered', async () => {
    let answer!: () => void;
    const env = await cashPanel({
      create: () =>
        new Promise((resolve) => {
          answer = () =>
            resolve(
              created(
                paymentOf({
                  status: 'confirmed',
                  tenderedSatang: satang(10000),
                  changeSatang: satang(2500),
                }),
                orderOf({ paymentStatus: 'paid' }, 11),
              ),
            );
        }),
    });
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(env.api.payments.create).toHaveBeenCalled());
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
    const busy = screen.getByRole('button', { name: th['payment.sending'] }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => answer());
    await screen.findByText(th['payment.paid.title']);
  });

  test('a double tap sends one request', async () => {
    let answer!: () => void;
    const env = await cashPanel({
      create: () =>
        new Promise((resolve) => {
          answer = () =>
            resolve(
              created(paymentOf({ status: 'confirmed' }), orderOf({ paymentStatus: 'paid' }, 11)),
            );
        }),
    });
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    const button = confirmButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    await act(async () => answer());
  });

  test('a refusal is explained from our own text, and the tender stays', async () => {
    await cashPanel({
      create: async () => {
        throw new ApiClientError('TENDERED_BELOW_TOTAL', { status: 422 });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(th['error.tenderedBelowTotal']);
    expect(screen.getByText('฿100.00', { selector: 'output' })).toBeTruthy();
  });

  test('an unanswered request is "unsure": the tender is locked and a retry sends the same request id', async () => {
    let calls = 0;
    const env = await cashPanel({
      create: async () => {
        calls += 1;
        if (calls === 1) throw new ApiClientError('TIMEOUT');
        return created(paymentOf({ status: 'confirmed' }), orderOf({ paymentStatus: 'paid' }, 11));
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.unsure']);
    // The tender cannot change now: the body must stay the same.
    expect((screen.getByRole('button', { name: '1' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '฿500' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.paid.title']);
    const ids = env.api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(ids[1]).toBe(ids[0]);
  });

  test('the app is held busy while a tender is being typed, so an update cannot reload the page', async () => {
    const env = await cashPanel();
    expect(env.activity.isBusy()).toBe(false);
    press('5');
    expect(env.activity.isBusy()).toBe(true);
    press('0');
    fireEvent.click(screen.getByRole('button', { name: th['payment.cash.clear'] }));
    expect(env.activity.isBusy()).toBe(false);
  });

  test('a kitchen role cannot take payments', async () => {
    const env = await setup({ role: 'kitchen' });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
    expect(env.api.payments.list).not.toHaveBeenCalled();
  });
});

describe('a paid order', () => {
  const paidOrder = () => orderOf({ paymentStatus: 'paid' }, 12);
  const cashPayment = () =>
    paymentOf({
      status: 'confirmed',
      tenderedSatang: satang(10000),
      changeSatang: satang(2500),
      confirmedAt: '2030-10-15T05:01:00.000Z',
    });

  test('shows the payment as received, with the change given, and the method cannot change', async () => {
    const env = await setup({ order: paidOrder(), payments: [cashPayment()] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.paid.title'])).toBeTruthy();
    expect(screen.getAllByText(/฿25\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(th['payment.change.confirmedLocked'])).toBeTruthy();
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
    expect(screen.queryByRole('button', { name: th['payment.change.button'] })).toBeNull();
  });

  test('follows a realtime frame: the order turns paid when another device takes the money', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(methodTile(th['payment.method.cash'])).toBeTruthy();
    act(() => {
      env.entities.apply(paymentFrame(PAYMENT, ORDER, 150, cashPayment()));
      env.entities.apply(orderFrame(ORDER, 151, paidOrder()));
    });
    expect(screen.getByText(th['payment.paid.title'])).toBeTruthy();
  });
});

describe('the payment history', () => {
  test('lists every payment of the order, newest first, with its status and details', async () => {
    const env = await setup({
      order: orderOf({ paymentStatus: 'paid' }, 12),
      payments: [
        paymentOf(
          { status: 'cancelled', method: 'promptpay', tenderedSatang: null, changeSatang: null },
          100,
        ),
        paymentDto(uuid(501), ORDER, 120, {
          amountSatang: TOTAL,
          status: 'confirmed',
          method: 'cash',
          tenderedSatang: satang(10000),
          changeSatang: satang(2500),
          referenceNote: 'A77',
        }),
      ],
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    const history = screen.getByRole('region', { name: th['payment.history.title'] });
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(th['payment.method.cash']);
    expect(rows[0]?.textContent).toContain(th['payment.status.confirmed']);
    expect(rows[0]?.textContent).toContain('฿100.00');
    expect(rows[0]?.textContent).toContain('฿25.00');
    expect(rows[0]?.textContent).toContain('A77');
    expect(rows[1]?.textContent).toContain(th['payment.method.promptpay']);
    expect(rows[1]?.textContent).toContain(th['payment.status.cancelled']);
  });

  test('a payment frame adds a row live', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.queryByRole('region', { name: th['payment.history.title'] })).toBeNull();
    act(() => {
      env.entities.apply(
        paymentFrame(PAYMENT, ORDER, 150, {
          status: 'pending',
          method: 'promptpay',
          amountSatang: TOTAL,
        }),
      );
    });
    expect(screen.getByRole('region', { name: th['payment.history.title'] })).toBeTruthy();
  });

  test('shows a void reason', async () => {
    const env = await setup({
      payments: [paymentOf({ status: 'voided', reason: 'ทอนผิด' })],
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(/ทอนผิด/)).toBeTruthy();
    expect(screen.getByText(th['payment.status.voided'])).toBeTruthy();
  });
});

describe('language', () => {
  test('reads in English', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services, 'en');
    await waitFor(() => expect(screen.queryByText(en['payment.loading'])).toBeNull());
    expect(screen.getByRole('radio', { name: new RegExp(en['payment.method.cash']) })).toBeTruthy();
    expect(screen.getByText(en['payment.amountDue'])).toBeTruthy();
  });
});
