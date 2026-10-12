// @vitest-environment jsdom

import type { OrderPaymentsResponse, SlipVerifyVerdict } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
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
import { canRecheckSlip, recheckErrorKey, showNoSlipFlag, slipIsBankMatched } from './slip-gate.ts';

// A claim with no slip is flagged in amber; a bank-matched slip says so; a slip whose bank answer
// is not `valid` can be checked again (D-27). None of it confirms money: staff still confirm.

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

const withVerdict = (verdict: SlipVerifyVerdict): OrderPaymentsResponse => ({
  payments: [claimed],
  slipPaymentIds: [PAYMENT],
  slipChecks: [{ paymentId: PAYMENT, verify: { verdict } }],
});
const noSlip: OrderPaymentsResponse = {
  payments: [claimed],
  slipPaymentIds: [],
  claimedWithoutSlipPaymentIds: [PAYMENT],
};

async function open(
  first: OrderPaymentsResponse,
  recheck: () => Promise<OrderPaymentsResponse> = async () => first,
) {
  const slipRecheck = vi.fn(recheck);
  const env = await setup({
    order: orderOf({ paymentStatus: 'awaiting_confirmation' }),
    payments: [claimed],
    api: {
      list: vi.fn(async () => first),
      slipRecheck,
      qrUrl: vi.fn(async () => ({
        url: 'https://x.test/q',
        expiresAt: '2030-10-15T05:05:00.000Z',
        promptpayTargetMasked: '******1234',
      })),
    },
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return { slipRecheck };
}

describe('claimed without a slip', () => {
  test('shows the amber flag, and confirm stays available', async () => {
    await open(noSlip);
    const flag = await screen.findByTestId('no-slip-flag');
    expect(flag.textContent).toContain(th['pos.slipFlag.noSlip']);
    expect(screen.queryByRole('button', { name: /ปิด|dismiss/i })).toBeNull();
    expect((screen.getByRole('button', { name: /ยืนยันรับเงิน/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('no flag when the payment is not listed as slip-less', async () => {
    await open({ payments: [claimed], slipPaymentIds: [] });
    await screen.findByTestId('slip-missing');
    expect(screen.queryByTestId('no-slip-flag')).toBeNull();
  });
});

describe('a bank-matched slip', () => {
  test('says it matches and offers no re-check', async () => {
    await open(withVerdict('valid'));
    const line = await screen.findByTestId('slip-matched');
    expect(line.textContent).toBe(th['pos.slipMatched.title']);
    expect(screen.queryByTestId('slip-recheck')).toBeNull();
  });

  test('other verdicts do not say it matches', async () => {
    await open(withVerdict('not_found'));
    await screen.findByTestId('slip-verify');
    expect(screen.queryByTestId('slip-matched')).toBeNull();
  });
});

describe('the re-check button', () => {
  test('is busy while it runs, then shows the new answer', async () => {
    let finish: (a: OrderPaymentsResponse) => void = () => {};
    const { slipRecheck } = await open(
      withVerdict('unchecked'),
      () => new Promise((resolve) => (finish = resolve)),
    );
    const button = (await screen.findByTestId('slip-recheck')) as HTMLButtonElement;
    expect(button.textContent).toBe(th['pos.slipRecheck.button']);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toBe(th['pos.slipRecheck.busy']);
    finish(withVerdict('valid'));
    await screen.findByTestId('slip-matched');
    expect(slipRecheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('slip-recheck')).toBeNull();
  });

  test.each([
    ['SLIP_RECHECK_LIMIT', 'pos.slipRecheck.err.limit'],
    ['SLIP2GO_DAILY_CAP', 'pos.slipRecheck.err.dailyCap'],
    ['SLIP_CHECK_RUNNING', 'pos.slipRecheck.err.running'],
    ['SLIP_VERIFIER_OFF', 'pos.slipRecheck.err.off'],
  ] as const)('%s is said in Thai, with no code shown', async (code, key) => {
    await open(withVerdict('pending'), async () => {
      throw new ApiClientError(code, { status: 429 });
    });
    fireEvent.click(await screen.findByTestId('slip-recheck'));
    const message = await screen.findByTestId('slip-recheck-error');
    expect(message.textContent).toBe(th[key]);
    expect(message.textContent).not.toContain(code);
  });
});

describe('slip-gate helpers', () => {
  const facts = (verdict: SlipVerifyVerdict | null, over = {}) => ({
    hasSlip: true,
    check: null,
    recipient: null,
    duplicate: false,
    verdict,
    ...over,
  });

  test('the flag follows the server list only', () => {
    expect(showNoSlipFlag('a', ['a', 'b'])).toBe(true);
    expect(showNoSlipFlag('c', ['a'])).toBe(false);
    expect(showNoSlipFlag('a', undefined)).toBe(false);
  });

  test('matched needs a valid verdict and no duplicate', () => {
    expect(slipIsBankMatched(facts('valid'))).toBe(true);
    expect(slipIsBankMatched(facts('valid', { duplicate: true }))).toBe(false);
    expect(slipIsBankMatched(facts('unchecked'))).toBe(false);
    expect(slipIsBankMatched(facts(null))).toBe(false);
  });

  test('re-check: claimed, has a slip, bank answer present and not valid', () => {
    for (const v of ['unchecked', 'pending', 'not_found', 'amount_mismatch', 'fraud'] as const) {
      expect(canRecheckSlip('claimed', facts(v))).toBe(true);
    }
    expect(canRecheckSlip('claimed', facts('valid'))).toBe(false);
    expect(canRecheckSlip('claimed', facts(null))).toBe(false);
    expect(canRecheckSlip('confirmed', facts('unchecked'))).toBe(false);
    expect(canRecheckSlip('claimed', facts('unchecked', { hasSlip: false }))).toBe(false);
  });

  test('every refusal code has its own message, others fall back', () => {
    const keys = [
      'SLIP_VERIFIER_OFF',
      'PAYMENT_NOT_CLAIMED',
      'NO_SLIP',
      'SLIP_CHECK_RUNNING',
      'SLIP_RECHECK_LIMIT',
      'SLIP2GO_DAILY_CAP',
    ].map(recheckErrorKey);
    expect(new Set(keys).size).toBe(6);
    expect(recheckErrorKey('NETWORK')).toBe('pos.slipRecheck.err.failed');
    expect(recheckErrorKey(undefined)).toBe('pos.slipRecheck.err.failed');
  });
});
