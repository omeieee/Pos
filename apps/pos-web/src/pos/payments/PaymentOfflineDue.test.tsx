// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IDS } from '../../test-support/fixtures.ts';
import {
  fixClock,
  loaded,
  methodTile,
  ORDER,
  orderOf,
  paymentOf,
  setup,
  th,
} from '../../test-support/payment-env.tsx';
import { renderScreen } from '../../test-support/render.tsx';
import { PROMPTPAY_CACHE_SCHEMA } from '../outbox/offline-promptpay-model.ts';
import { PaymentPanel } from './PaymentPanel.tsx';

beforeEach(fixClock);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Order total 150.00, 100.00 already received, so 50.00 is still due. Offline, the amount that
// is queued and drawn in the QR must be the 50.00 due, never the 150.00 order total.
const partly = () => orderOf({ totalSatang: satang(15000), paymentStatus: 'partially_paid' }, 12);
const received = () =>
  paymentOf({
    status: 'confirmed',
    amountSatang: satang(10000),
    confirmedAt: '2030-10-15T05:01:00.000Z',
  });
const list = vi.fn(async () => ({
  payments: [received()],
  refunds: [],
  netPaidSatang: satang(10000),
  dueSatang: satang(5000),
}));

describe('a partly paid order, paid while the device is offline', () => {
  test('cash is queued for the amount still due', async () => {
    const env = await setup({
      offline: true,
      order: partly(),
      payments: [received()],
      api: { list },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: th['payment.cash.exact'] }));
    fireEvent.click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(env.outbox.getState().items).toHaveLength(1));
    expect(env.outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      orderId: ORDER,
      tenderedSatang: 5000,
      totalSatang: 5000,
    });
  });

  test('the offline PromptPay QR is drawn and queued for the amount still due', async () => {
    const env = await setup({
      offline: true,
      order: partly(),
      payments: [received()],
      api: { list },
      promptpay: {
        record: {
          v: PROMPTPAY_CACHE_SCHEMA,
          staffId: IDS.cashier,
          savedAt: Date.now() - 5 * 60_000,
          rev: 5,
          stale: false,
          target: { idType: 'phone', idValue: '0812345678' },
        },
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img', {
      name: th['payment.offlineQr.alt'].replace('{amount}', '฿50.00'),
    });
    fireEvent.click(screen.getByRole('button', { name: th['payment.offlineQr.confirm'] }));
    await waitFor(() => expect(env.outbox.getState().items).toHaveLength(1));
    expect(env.outbox.getState().items[0]).toMatchObject({
      method: 'promptpay',
      orderId: ORDER,
      qrAmountSatang: 5000,
    });
  });
});
