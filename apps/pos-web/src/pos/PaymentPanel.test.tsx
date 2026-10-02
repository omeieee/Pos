// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import {
  orderFrame,
  paymentDto,
  paymentFrame,
  paymentMethodsFrame,
  uuid,
} from '../test-support/frames.ts';
import {
  created,
  en,
  fixClock,
  loaded,
  methodTile,
  ORDER,
  orderOf,
  PAYMENT,
  paymentOf,
  type SetupOptions,
  setup,
  TOTAL,
  th,
} from '../test-support/payment-env.tsx';
import { renderScreen } from '../test-support/render.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

beforeEach(fixClock);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const key = (name: string) => screen.getByRole('button', { name });
const press = (...keys: string[]) => {
  for (const k of keys) fireEvent.click(key(k));
};

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

  describe('while the outcome is unsure, leaving the screen and coming back', () => {
    /** A cash create whose first answer is lost, then a normal one. */
    async function unsureCash() {
      let calls = 0;
      const env = await cashPanel({
        create: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('TIMEOUT');
          return created(
            paymentOf({ status: 'confirmed' }),
            orderOf({ paymentStatus: 'paid' }, 11),
          );
        },
      });
      fireEvent.click(screen.getByRole('button', { name: '฿100' }));
      fireEvent.click(confirmButton());
      await screen.findByText(th['payment.unsure']);
      return env;
    }
    const keypadDisabled = () =>
      (screen.getByRole('button', { name: '1' }) as HTMLButtonElement).disabled;

    test('a remount restores the tender, keeps the keypad locked and retries with the same body and id', async () => {
      const env = await unsureCash();
      cleanup();
      renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
      await loaded();
      expect(screen.getByText('฿100.00', { selector: 'output' })).toBeTruthy();
      expect(screen.getByText(th['payment.unsure'])).toBeTruthy();
      expect(keypadDisabled()).toBe(true);
      expect(confirmButton().disabled).toBe(false);
      fireEvent.click(confirmButton());
      await screen.findByText(th['payment.paid.title']);
      const [first, second] = env.api.payments.create.mock.calls;
      expect(second?.[2]?.clientRequestId).toBe(first?.[2]?.clientRequestId);
      expect(second?.[1]).toEqual(first?.[1]);
    });

    test('flipping to another method and back restores the tender', async () => {
      const env = await unsureCash();
      fireEvent.click(methodTile(th['payment.method.promptpay']));
      // The earlier attempt was cash: the PromptPay start says an earlier attempt may exist.
      expect(screen.getByText(th['payment.unsureOtherMethod'])).toBeTruthy();
      fireEvent.click(methodTile(th['payment.method.cash']));
      expect(screen.getByText('฿100.00', { selector: 'output' })).toBeTruthy();
      expect(keypadDisabled()).toBe(true);
      expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    });

    test('an unsure attempt of another method does not lock the cash keypad, and is called out', async () => {
      let calls = 0;
      const env = await setup({
        api: {
          create: async () => {
            calls += 1;
            if (calls === 1) throw new ApiClientError('TIMEOUT');
            return created(paymentOf({ status: 'pending' }), orderOf({}, 11));
          },
        },
      });
      renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
      await loaded();
      fireEvent.click(methodTile(th['payment.method.promptpay']));
      fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
      await screen.findByText(th['payment.unsure']);
      fireEvent.click(methodTile(th['payment.method.cash']));
      expect(screen.getByText(th['payment.unsureOtherMethod'])).toBeTruthy();
      expect(keypadDisabled()).toBe(false);
    });
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

describe('a call for another order is still running', () => {
  const OTHER = uuid(901);

  test('says so and switches the controls off, instead of ignoring a tap', async () => {
    const env = await setup();
    env.entities.apply(orderFrame(OTHER, 30, { orderNo: 'S-014', totalSatang: TOTAL }));
    // A payment for the other order that is still on its way.
    let answer!: () => void;
    env.api.payments.create.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          answer = () => reject(new ApiClientError('FORBIDDEN', { status: 403 }));
        }),
    );
    void env.payments.create(OTHER, { method: 'promptpay' });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.busyElsewhere'])).toBeTruthy();
    fireEvent.click(methodTile(th['payment.method.cash']));
    expect(key('1').matches(':disabled')).toBe(true);
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByText(th['payment.busyElsewhere'])).toBeNull());
    expect(key('1').matches(':disabled')).toBe(false);
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
