// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
import { receiptFor } from './receipt-model.ts';

beforeEach(fixClock);
afterEach(cleanup);

const confirmed = () =>
  paymentOf({ status: 'confirmed', tenderedSatang: satang(10000), changeSatang: satang(2500) });
const paid = () => orderOf({ paymentStatus: 'paid' }, 12);

describe('receipt model', () => {
  test('only a paid, uncancelled order with a received payment has a receipt', () => {
    expect(receiptFor(paid(), confirmed())?.payment?.method).toBe('cash');
    expect(receiptFor(paid(), undefined)).toBeNull();
    expect(receiptFor(orderOf(), confirmed())).toBeNull();
    expect(receiptFor({ ...paid(), status: 'cancelled' }, confirmed())).toBeNull();
  });
});

describe('issuing a receipt at the payment panel', () => {
  test('nothing is issued until staff press it; then save and print use the platform seam', async () => {
    const env = await setup({ order: paid(), payments: [confirmed()] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(env.files.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.issue'] }));
    expect(env.files.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.save'] }));
    const [name, mime, html] = env.files.save.mock.calls[0] as [string, string, string];
    expect(name).toMatch(/^receipt-.*\.html$/);
    expect(mime).toBe('text/html');
    expect(html).toContain('฿75.00');
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.print'] }));
    expect(env.files.print).toHaveBeenCalledWith(html);
  });

  test('is not offered before the payment is confirmed', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.queryByRole('button', { name: th['payment.receipt.issue'] })).toBeNull();
  });
});
