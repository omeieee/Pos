// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  vi.restoreAllMocks();
});

const claimed = paymentOf({
  method: 'promptpay',
  status: 'claimed',
  tenderedSatang: null,
  changeSatang: null,
  confirmedAt: null,
  claimedAt: '2030-10-15T04:58:00.000Z',
  promptpayTargetMasked: '******1234',
});

async function open(slipPaymentIds: string[] | undefined | 'fail') {
  const list = vi.fn(async () => {
    if (slipPaymentIds === 'fail') throw new Error('network');
    return { payments: [claimed], ...(slipPaymentIds ? { slipPaymentIds } : {}) };
  });
  const env = await setup({
    order: orderOf({ paymentStatus: 'awaiting_confirmation' }),
    payments: [claimed],
    api: {
      list,
      qrUrl: vi.fn(async () => ({
        url: 'https://x.test/q',
        expiresAt: '2030-10-15T05:05:00.000Z',
        promptpayTargetMasked: '******1234',
      })),
    },
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return { env, list };
}

describe('claimed PromptPay: the slip', () => {
  test('a slip exists: says so and offers the view button', async () => {
    await open([PAYMENT]);
    expect(await screen.findByTestId('slip-has')).toBeTruthy();
    expect(screen.getByText(th['payment.slip.has'])).toBeTruthy();
    expect(screen.getByRole('button', { name: th['payment.slip.view'] })).toBeTruthy();
    expect(screen.queryByTestId('slip-missing')).toBeNull();
  });

  test('no slip: says the customer has not attached one, and has no view button', async () => {
    await open([]);
    expect(await screen.findByTestId('slip-missing')).toBeTruthy();
    expect(screen.getByText(th['payment.slip.missing'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.slip.view'] })).toBeNull();
  });

  test('an answer without the slip list counts as no slip', async () => {
    await open(undefined);
    expect(await screen.findByTestId('slip-missing')).toBeTruthy();
  });

  test('the list cannot be read: the button is still offered (no claim either way)', async () => {
    await open('fail');
    expect(await screen.findByRole('button', { name: th['payment.slip.view'] })).toBeTruthy();
    expect(screen.queryByTestId('slip-has')).toBeNull();
    expect(screen.queryByTestId('slip-missing')).toBeNull();
  });

  test('a new revision of the payment (the slip arrived with the claim) asks again', async () => {
    let ids: string[] = [];
    const { env, list } = await open([]);
    list.mockImplementation(async () => ({ payments: [claimed], slipPaymentIds: ids }));
    expect(await screen.findByTestId('slip-missing')).toBeTruthy();
    ids = [PAYMENT];
    act(() => {
      env.entities.apply({
        type: 'payment.upserted',
        id: claimed.id,
        rev: claimed.rev + 1,
        data: { ...claimed, rev: claimed.rev + 1 },
      });
    });
    await waitFor(() => expect(screen.getByTestId('slip-has')).toBeTruthy());
    expect(screen.queryByTestId('slip-missing')).toBeNull();
  });
});

describe('the slip of a payment that is no longer claimed', () => {
  const confirmed = paymentOf({
    method: 'promptpay',
    status: 'confirmed',
    confirmedAt: '2030-10-15T04:59:00.000Z',
  });

  async function openPaid(slipPaymentIds: string[], slip?: () => Promise<Blob>) {
    const env = await setup({
      order: orderOf({ paymentStatus: 'paid' }),
      payments: [confirmed],
      api: {
        list: vi.fn(async () => ({ payments: [confirmed], slipPaymentIds })),
        ...(slip ? { slip } : {}),
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    return env;
  }

  test('a confirmed PromptPay payment with a slip still offers it, from the history', async () => {
    await openPaid([PAYMENT]);
    expect(await screen.findByTestId('slip-has')).toBeTruthy();
    expect(screen.getByRole('button', { name: th['payment.slip.view'] })).toBeTruthy();
  });

  test('no slip: the history says nothing about one', async () => {
    await openPaid([]);
    await waitFor(() => expect(screen.queryByTestId('slip-has')).toBeNull());
    expect(screen.queryByTestId('slip-missing')).toBeNull();
    expect(screen.queryByRole('button', { name: th['payment.slip.view'] })).toBeNull();
  });

  test('a slip deleted after 90 days is said plainly', async () => {
    await openPaid([PAYMENT], async () => {
      throw Object.assign(new Error('gone'), { code: 'SLIP_NOT_FOUND' });
    });
    fireEvent.click(await screen.findByRole('button', { name: th['payment.slip.view'] }));
    expect(await screen.findByText(th['payment.slip.none'])).toBeTruthy();
    expect(th['payment.slip.none']).toContain('90');
  });
});
