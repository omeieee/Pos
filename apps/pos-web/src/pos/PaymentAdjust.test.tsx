// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { orderFrame, uuid } from '../test-support/frames.ts';
import {
  fixClock,
  loaded,
  ORDER,
  orderOf,
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

const refund = {
  id: uuid(70),
  paymentId: uuid(500),
  amountSatang: satang(2500),
  method: 'cash' as const,
  referenceNote: 'ทอนคืน',
  reason: 'ลดจาน',
  refundedAt: '2030-10-15T05:30:00.000Z',
};

// Order total 150.00; 100.00 already net received; 50.00 still due. Every figure is the server's.
const partly = () => orderOf({ totalSatang: satang(15000), paymentStatus: 'partially_paid' }, 12);
const paid = () =>
  paymentOf({
    status: 'confirmed',
    amountSatang: satang(12500),
    confirmedAt: '2030-10-15T05:01:00.000Z',
  });

describe('a partly paid order', () => {
  test('charges the server due, not the order total, and shows net paid, refunds and due', async () => {
    const list = vi.fn(async () => ({
      payments: [paid()],
      refunds: [refund],
      netPaidSatang: satang(10000),
      dueSatang: satang(5000),
    }));
    const env = await setup({ order: partly(), payments: [paid()], api: { list } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    const ledger = await screen.findByTestId('payment-ledger');
    expect(within(ledger).getByText(th['payment.ledger.netPaid'])).toBeTruthy();
    expect(within(ledger).getByText('฿100.00')).toBeTruthy();
    expect(within(ledger).getByText('฿25.00')).toBeTruthy();
    expect(within(ledger).getByText(th['payment.ledger.due'])).toBeTruthy();
    expect(within(ledger).getByText('฿50.00')).toBeTruthy();
    // The cash screen asks for the due: the confirm button names it, never ฿150.00.
    expect(screen.getAllByText(/฿50\.00/).length).toBeGreaterThan(1);
    expect(screen.queryByText(/฿150\.00/)).toBeNull();
  });

  test('when the ledger cannot be read it shows no amount and offers no cash chips', async () => {
    const list = vi.fn(async () => {
      throw new Error('offline');
    });
    const env = await setup({ order: partly(), payments: [paid()], api: { list } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => undefined);
    // Never the order total standing in for the due, and nothing that depends on the amount.
    expect(screen.queryByText(/฿150\.00/)).toBeNull();
    expect(screen.getByText(th['payment.loading'])).toBeTruthy();
    expect(screen.queryByText(th['payment.cash.exact'])).toBeNull();
  });

  test('a started payment shows its own amount', async () => {
    const waiting = paymentOf({
      method: 'promptpay',
      status: 'pending',
      amountSatang: satang(5000),
    });
    const list = vi.fn(async () => ({
      payments: [waiting],
      refunds: [],
      netPaidSatang: satang(10000),
      dueSatang: satang(5000),
    }));
    const env = await setup({ order: partly(), payments: [waiting], api: { list } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getAllByText(/฿50\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/฿150\.00/)).toBeNull();
  });

  test('reads the payments again when the order itself changes', async () => {
    const list = vi.fn(async () => ({
      payments: [],
      refunds: [],
      netPaidSatang: satang(0),
      dueSatang: satang(7500),
    }));
    const env = await setup({ api: { list } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    const first = list.mock.calls.length;
    act(() => {
      env.entities.apply(orderFrame(ORDER, 99, orderOf({ totalSatang: satang(9000) }, 99)));
    });
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(first));
  });

  test('an order paid in one go shows no ledger', async () => {
    const list = vi.fn(async () => ({
      payments: [],
      refunds: [],
      netPaidSatang: satang(7500),
      dueSatang: satang(0),
    }));
    const env = await setup({ order: orderOf({ paymentStatus: 'paid' }, 12), api: { list } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.queryByTestId('payment-ledger')).toBeNull();
    fireEvent.click(document.body);
  });
});
