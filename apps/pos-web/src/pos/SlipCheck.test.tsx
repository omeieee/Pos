// @vitest-environment jsdom

import { type SlipCheck, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

// The automatic reading of the slip (D-26) is a HINT: a banner, a chip and one extra tap on a
// mismatch. It never confirms or blocks money by itself (rule 2).

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
const confirmedPayment = paymentOf({
  ...claimed,
  status: 'confirmed',
  confirmedAt: '2030-10-15T04:59:00.000Z',
});

// The order total in the fixtures is ฿75.00.
async function open(check: SlipCheck | null, amountSatang: number | null = null) {
  const confirm = vi.fn(async () => ({
    payment: confirmedPayment,
    order: orderOf({ paymentStatus: 'paid' }),
  }));
  const list = vi.fn(async () => ({
    payments: [claimed],
    slipPaymentIds: [PAYMENT],
    ...(check
      ? {
          slipChecks: [
            {
              paymentId: PAYMENT,
              check,
              amountSatang: amountSatang === null ? null : satang(amountSatang),
            },
          ],
        }
      : {}),
  }));
  const env = await setup({
    order: orderOf({ paymentStatus: 'awaiting_confirmation' }),
    payments: [claimed],
    api: {
      list,
      confirm,
      qrUrl: vi.fn(async () => ({
        url: 'https://x.test/q',
        expiresAt: '2030-10-15T05:05:00.000Z',
        promptpayTargetMasked: '******1234',
      })),
    },
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return { confirm };
}

const confirmButton = () => screen.getByRole('button', { name: /ยืนยันรับเงิน/ });

describe('the banner', () => {
  test('a matching amount is a green note with the amount, and says it is only a hint', async () => {
    await open('match', 7500);
    const banner = await screen.findByTestId('slip-check');
    expect(banner.getAttribute('data-check')).toBe('match');
    expect(banner.textContent).toContain('ยอดบนสลิปตรงกับออเดอร์ ฿75.00');
    expect(banner.textContent).toContain(th['payment.slip.check.hint']);
  });

  test('a different amount names both amounts', async () => {
    await open('mismatch', 6000);
    const banner = await screen.findByTestId('slip-check');
    expect(banner.getAttribute('data-check')).toBe('mismatch');
    expect(banner.textContent).toContain('ยอดบนสลิป ฿60.00 ไม่ตรงกับ ฿75.00');
    expect(banner.textContent).toContain(th['payment.slip.check.hint']);
  });

  test('an unreadable slip says to check by eye', async () => {
    await open('unreadable');
    const banner = await screen.findByTestId('slip-check');
    expect(banner.getAttribute('data-check')).toBe('unreadable');
    expect(banner.textContent).toContain('อ่านยอดจากสลิปไม่ได้ ตรวจด้วยตา');
  });

  test('a reading that is still going says so', async () => {
    await open('pending');
    const banner = await screen.findByTestId('slip-check');
    expect(banner.getAttribute('data-check')).toBe('pending');
  });

  test('no reading at all (the check is off): no banner, no chip, the old note stays', async () => {
    await open(null);
    expect(await screen.findByTestId('slip-has')).toBeTruthy();
    expect(screen.queryByTestId('slip-check')).toBeNull();
    expect(screen.queryByTestId('slip-chip')).toBeNull();
  });

  test('a small chip sits next to the slip note, and the fake-slip warning still shows', async () => {
    await open('mismatch', 6000);
    const chip = await screen.findByTestId('slip-chip');
    expect(chip.textContent).toContain(th['payment.slip.chip.mismatch']);
    fireEvent.click(screen.getByRole('button', { name: th['payment.slip.view'] }));
    // The picture opens only on request; the warning comes with it as before.
    await waitFor(() => expect(screen.queryByTestId('slip-chip')).toBeTruthy());
  });
});

describe('confirming', () => {
  test.each([
    ['match', 7500],
    ['unreadable', null],
    ['pending', null],
  ] as const)('with %s one tap confirms, as before', async (check, amount) => {
    const { confirm } = await open(check, amount);
    await screen.findByTestId('slip-check');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });

  test('with no reading one tap confirms, as before', async () => {
    const { confirm } = await open(null);
    await screen.findByTestId('slip-has');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });

  test('on a mismatch the first tap only asks again, and the second tap confirms', async () => {
    const { confirm } = await open('mismatch', 6000);
    await screen.findByTestId('slip-check');
    fireEvent.click(confirmButton());
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(th['payment.confirmMismatchWarn']);
    expect(confirmButton().textContent).toContain('ยอดสลิปไม่ตรง');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });
});
