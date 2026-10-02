// @vitest-environment jsdom
import type { PaymentDto } from '@sds/shared';
import { satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { govCopayFrame, paymentMethodsFrame } from '../test-support/frames.ts';
import {
  fixClock,
  loaded,
  ORDER,
  orderOf,
  PAYMENT,
  paymentOf,
  setup,
  th,
} from '../test-support/payment-env.tsx';
import { renderScreen } from '../test-support/render.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

beforeEach(fixClock);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NEW = '0192f3a0-0000-7000-8000-000000000501';
const waiting = (method: 'promptpay' | 'gov_copay', over: Partial<PaymentDto> = {}) =>
  paymentOf({
    method,
    status: 'pending',
    tenderedSatang: null,
    changeSatang: null,
    confirmedAt: null,
    ...over,
  });

const changeResult = (payment: PaymentDto, cancelled: PaymentDto, order = orderOf({}, 12)) => ({
  result: { payment, cancelledPayment: cancelled, order },
  replay: false,
  clientRequestId: NEW,
});

async function panel(options: Parameters<typeof setup>[0] = {}) {
  const env = await setup({
    frames: [govCopayFrame(6)],
    api: {
      qrUrl: async () => ({
        url: 'https://api.example.test/qr',
        expiresAt: '2030-10-15T05:05:00.000Z',
        promptpayTargetMasked: '******1234',
      }),
    },
    ...options,
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return env;
}

const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: th['payment.change.button'] }));
  return screen.getByRole('dialog');
};

describe('changing the method of a waiting payment', () => {
  test('is offered while the payment is pending, and lists the OTHER methods only', async () => {
    await panel({ payments: [waiting('promptpay')] });
    const dialog = openSheet();
    expect(within(dialog).getByText(th['payment.change.hint'])).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /เงินสด/ })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /ไทยช่วยไทย/ })).toBeTruthy();
    expect(within(dialog).queryByRole('radio', { name: /พร้อมเพย์/ })).toBeNull();
  });

  test('is not offered once the customer has claimed it: the claim has to be cancelled first', async () => {
    await panel({
      payments: [
        waiting('promptpay', { status: 'claimed', claimedAt: '2030-10-15T04:58:00.000Z' }),
      ],
      order: orderOf({ paymentStatus: 'awaiting_confirmation' }),
    });
    expect(screen.queryByRole('button', { name: th['payment.change.button'] })).toBeNull();
    expect(screen.getByText(th['payment.change.claimedFirst'])).toBeTruthy();
  });

  test('is not offered once the payment is confirmed', async () => {
    await panel({
      order: orderOf({ paymentStatus: 'paid' }, 12),
      payments: [paymentOf({ status: 'confirmed' })],
    });
    expect(screen.queryByRole('button', { name: th['payment.change.button'] })).toBeNull();
    expect(screen.getByText(th['payment.change.confirmedLocked'])).toBeTruthy();
  });

  test('to cash: the keypad opens, and confirming sends the method and the tender in ONE call', async () => {
    const paid = paymentOf({
      id: NEW,
      status: 'confirmed',
      method: 'cash',
      tenderedSatang: satang(10000),
      changeSatang: satang(2500),
      rev: 130,
    });
    const old = waiting('promptpay', { status: 'cancelled', rev: 131 });
    const env = await panel({
      payments: [waiting('promptpay')],
      api: {
        changeMethod: async () => changeResult(paid, old, orderOf({ paymentStatus: 'paid' }, 12)),
      },
    });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: /เงินสด/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '฿100' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /ยืนยันรับเงิน/ }));
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.create).not.toHaveBeenCalled();
    expect(env.api.payments.changeMethod).toHaveBeenCalledTimes(1);
    const [paymentId, input, options] = env.api.payments.changeMethod.mock.calls[0] ?? [];
    expect(paymentId).toBe(PAYMENT);
    expect(input).toEqual({ method: 'cash', tendered: 10000 });
    expect(options?.clientRequestId).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('to ไทยช่วยไทย: one tap, then the guided steps show for the new payment', async () => {
    const gov = waiting('gov_copay', {
      id: NEW,
      rev: 130,
      estGovShareSatang: satang(4500),
      estCustomerShareSatang: satang(3000),
    });
    const env = await panel({
      payments: [waiting('promptpay')],
      api: {
        changeMethod: async () =>
          changeResult(gov, waiting('promptpay', { status: 'cancelled', rev: 131 })),
      },
    });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: /ไทยช่วยไทย/ }));
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['payment.change.confirm'].replace('{method}', th['payment.method.gov_copay']),
      }),
    );
    await screen.findByRole('region', { name: th['payment.govCopay.title'] });
    expect(env.api.payments.changeMethod.mock.calls[0]?.[1]).toEqual({ method: 'gov_copay' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('from ไทยช่วยไทย to PromptPay shows the QR of the new payment', async () => {
    const pp = waiting('promptpay', { id: NEW, rev: 130 });
    const env = await panel({
      payments: [waiting('gov_copay')],
      api: {
        changeMethod: async () =>
          changeResult(pp, waiting('gov_copay', { status: 'cancelled', rev: 131 })),
        qrUrl: async () => ({
          url: 'https://api.example.test/qr',
          expiresAt: '2030-10-15T05:05:00.000Z',
          promptpayTargetMasked: '******1234',
        }),
      },
    });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: /พร้อมเพย์/ }));
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['payment.change.confirm'].replace('{method}', th['payment.method.promptpay']),
      }),
    );
    await screen.findByRole('img', { name: /QR พร้อมเพย์/ });
    expect(env.api.payments.changeMethod.mock.calls[0]?.[1]).toEqual({ method: 'promptpay' });
  });

  test('closing the sheet sends nothing and keeps the waiting payment', async () => {
    const env = await panel({ payments: [waiting('promptpay')] });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.cancel'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(env.api.payments.changeMethod).not.toHaveBeenCalled();
  });

  test('ไทยช่วยไทย is disabled with its reason when it cannot be used', async () => {
    await panel({
      payments: [waiting('promptpay')],
      order: orderOf({ fulfillment: 'room_delivery', roomNo: '1204' }),
    });
    const dialog = openSheet();
    expect(
      (within(dialog).getByRole('radio', { name: /ไทยช่วยไทย/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(within(dialog).getByText(th['payment.copay.reason.notAtCounter'])).toBeTruthy();
  });

  test('a method the owner switched off is not listed', async () => {
    await panel({
      payments: [waiting('promptpay')],
      frames: [govCopayFrame(6), paymentMethodsFrame(7, { cash: false })],
    });
    const dialog = openSheet();
    expect(within(dialog).queryByRole('radio', { name: /เงินสด/ })).toBeNull();
  });

  test('an unanswered change is unsure, locks the choice and retries with the same request id', async () => {
    let calls = 0;
    const gov = waiting('gov_copay', { id: NEW, rev: 130 });
    const env = await panel({
      payments: [waiting('promptpay')],
      api: {
        changeMethod: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('TIMEOUT');
          return changeResult(gov, waiting('promptpay', { status: 'cancelled', rev: 131 }));
        },
      },
    });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: /ไทยช่วยไทย/ }));
    const go = () =>
      within(dialog).getByRole('button', {
        name: th['payment.change.confirm'].replace('{method}', th['payment.method.gov_copay']),
      });
    fireEvent.click(go());
    await within(dialog).findByText(th['payment.unsure']);
    fireEvent.click(go());
    await screen.findByRole('region', { name: th['payment.govCopay.title'] });
    const ids = env.api.payments.changeMethod.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(ids[1]).toBe(ids[0]);
  });

  test('a payment another device already claimed refuses the change, says so and reloads', async () => {
    const env = await panel({
      payments: [waiting('promptpay')],
      api: {
        changeMethod: async () => {
          throw new ApiClientError('PAYMENT_NOT_PENDING', { status: 409 });
        },
      },
    });
    const dialog = openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: /ไทยช่วยไทย/ }));
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: th['payment.change.confirm'].replace('{method}', th['payment.method.gov_copay']),
      }),
    );
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(th['error.paymentNotPending']);
    await waitFor(() => expect(env.api.payments.list.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('a method the server refuses as disabled', () => {
  test('is taken off the list (cash switched off after this page loaded)', async () => {
    const env = await panel({
      api: {
        create: async () => {
          throw new ApiClientError('METHOD_DISABLED', { status: 422 });
        },
      },
    });
    // Cash is selected first.
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    fireEvent.click(screen.getByRole('button', { name: /ยืนยันรับเงิน/ }));
    await waitFor(() => expect(screen.queryByRole('radio', { name: /เงินสด/ })).toBeNull());
    expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    // The next choice is offered instead.
    expect(screen.getByRole('radio', { name: /พร้อมเพย์/ })).toBeTruthy();
  });
});
