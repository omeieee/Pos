// @vitest-environment jsdom

import {
  type OrderPaymentsResponse,
  SLIP_VERIFY_VERDICTS,
  type SlipVerifyVerdict,
} from '@sds/shared';
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
} from '../../test-support/payment-env.tsx';
import { renderScreen } from '../../test-support/render.tsx';
import { PaymentPanel } from '../payments/PaymentPanel.tsx';

// The bank check (D-27, Slip2Go) is shown as one banner per verdict. Only `valid` without a local
// duplicate keeps the one-tap confirm; every other answer needs the bank-app tick. When the check
// is off (no `verify`) the older OCR rule applies. A payment the server confirmed by itself is
// labelled and can still be voided or refunded.

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

interface Entry {
  verdict?: SlipVerifyVerdict;
  check?: 'match' | 'mismatch' | 'unreadable' | 'pending';
  recipientCheck?: 'match' | 'mismatch' | 'unknown';
}

async function open(
  entry: Entry,
  duplicate?: { orderNo: string; paymentStatus: 'claimed' | 'confirmed' },
) {
  const confirm = vi.fn(async () => ({
    payment: confirmedPayment,
    order: orderOf({ paymentStatus: 'paid' }),
  }));
  const list = vi.fn<() => Promise<OrderPaymentsResponse>>(async () => ({
    payments: [claimed],
    slipPaymentIds: [PAYMENT],
    slipChecks: [
      {
        paymentId: PAYMENT,
        ...(entry.check ? { check: entry.check, amountSatang: null } : {}),
        ...(entry.recipientCheck ? { recipientCheck: entry.recipientCheck } : {}),
        ...(entry.verdict ? { verify: { verdict: entry.verdict } } : {}),
      },
    ],
    ...(duplicate ? { slipDuplicates: [{ paymentId: PAYMENT, ...duplicate }] } : {}),
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
  return { confirm, env, list };
}

const confirmButton = () => screen.getByRole('button', { name: /ยืนยันรับเงิน/ });
const tick = () => screen.getByRole('checkbox', { name: th['payment.bankCheck.label'] });

describe('one banner per bank verdict', () => {
  test.each(SLIP_VERIFY_VERDICTS)('%s shows its own Thai text', async (verdict) => {
    await open({ verdict });
    const banner = await screen.findByTestId('slip-verify');
    expect(banner.getAttribute('data-verdict')).toBe(verdict);
    expect(banner.textContent).toContain(th[`payment.slip.verify.${verdict}`]);
    expect((await screen.findByTestId('slip-verify-chip')).textContent).toContain(
      th[`payment.slip.verify.chip.${verdict}`],
    );
  });

  test('valid says it was checked with the bank, in green', async () => {
    await open({ verdict: 'valid' });
    const banner = await screen.findByTestId('slip-verify');
    expect(banner.textContent).toContain('ตรวจกับธนาคารแล้ว: ยอด บัญชีผู้รับ และเวลาตรง (Slip2Go)');
    expect(banner.querySelector('[role="status"]')).toBeTruthy();
  });

  test.each(['receiver_mismatch', 'not_found', 'fraud'] as const)(
    '%s is announced as an alert',
    async (verdict) => {
      await open({ verdict });
      const banner = await screen.findByTestId('slip-verify');
      expect(banner.querySelector('[role="alert"]')).toBeTruthy();
    },
  );

  test('pending says the bank is being asked, as a quiet status', async () => {
    await open({ verdict: 'pending' });
    const banner = await screen.findByTestId('slip-verify');
    expect(banner.textContent).toContain('กำลังตรวจกับธนาคาร…');
    expect(banner.querySelector('[role="status"]')).toBeTruthy();
  });

  test('unchecked says to check in the bank app', async () => {
    await open({ verdict: 'unchecked' });
    expect((await screen.findByTestId('slip-verify')).textContent).toContain(
      'ตรวจอัตโนมัติไม่ได้ ตรวจในแอปธนาคาร',
    );
  });

  test('no OCR data: no OCR banner and no OCR chip', async () => {
    await open({ verdict: 'valid' });
    await screen.findByTestId('slip-verify');
    expect(screen.queryByTestId('slip-check')).toBeNull();
    expect(screen.queryByTestId('slip-chip')).toBeNull();
  });

  test('both exist: both show, the bank verdict first', async () => {
    await open({ verdict: 'amount_mismatch', check: 'mismatch' });
    const bank = await screen.findByTestId('slip-verify');
    const ocr = await screen.findByTestId('slip-check');
    expect(bank.compareDocumentPosition(ocr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a local duplicate banner stays above the bank verdict', async () => {
    await open({ verdict: 'valid' }, { orderNo: 'L-012', paymentStatus: 'confirmed' });
    const dup = await screen.findByTestId('slip-duplicate');
    const bank = await screen.findByTestId('slip-verify');
    expect(dup.compareDocumentPosition(bank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('confirming with a bank verdict', () => {
  test('valid and new: one tap, no tick, nothing extra sent', async () => {
    const { confirm } = await open({ verdict: 'valid' });
    await screen.findByTestId('slip-verify');
    expect(screen.queryByRole('checkbox', { name: th['payment.bankCheck.label'] })).toBeNull();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(PAYMENT, {});
  });

  test('valid overrides OCR that disagrees: still one tap', async () => {
    await open({ verdict: 'valid', check: 'mismatch', recipientCheck: 'mismatch' });
    await screen.findByTestId('slip-verify');
    expect(screen.queryByRole('checkbox', { name: th['payment.bankCheck.label'] })).toBeNull();
  });

  test.each(SLIP_VERIFY_VERDICTS.filter((v) => v !== 'valid'))(
    '%s: confirm stays off until the tick',
    async (verdict) => {
      const { confirm } = await open({ verdict });
      await screen.findByTestId('slip-verify');
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(tick());
      fireEvent.click(confirmButton());
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(confirm).toHaveBeenCalledWith(PAYMENT, { attestedBankCheck: true });
    },
  );

  test('valid but a local duplicate: the tick is needed', async () => {
    await open({ verdict: 'valid' }, { orderNo: 'L-012', paymentStatus: 'claimed' });
    await screen.findByTestId('slip-duplicate');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(tick()).toBeTruthy();
  });

  test('verify absent (the check is off): the OCR rule still decides', async () => {
    await open({ check: 'match', recipientCheck: 'match' });
    await screen.findByTestId('slip-check');
    expect(screen.queryByTestId('slip-verify')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: th['payment.bankCheck.label'] })).toBeNull();
    cleanup();
    await open({ check: 'match', recipientCheck: 'unknown' });
    await screen.findByTestId('slip-check');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a slip entry with neither OCR nor verify needs the tick', async () => {
    await open({});
    await screen.findByTestId('slip-has');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a verdict arriving later (new revision) turns the tick off for a valid slip', async () => {
    const { env, list } = await open({ verdict: 'pending' });
    await screen.findByTestId('slip-verify');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    list.mockImplementation(async () => ({
      payments: [claimed],
      slipPaymentIds: [PAYMENT],
      slipChecks: [{ paymentId: PAYMENT, verify: { verdict: 'valid' as const } }],
    }));
    act(() => {
      env.entities.apply({
        type: 'payment.upserted',
        id: claimed.id,
        rev: claimed.rev + 1,
        data: { ...claimed, rev: claimed.rev + 1 },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('slip-verify').getAttribute('data-verdict')).toBe('valid'),
    );
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a payment the server confirmed by itself (D-27)', () => {
  const auto = paymentOf({ ...confirmedPayment, rev: 120 });

  async function openAuto(listed: boolean) {
    const env = await setup({
      role: 'manager',
      order: orderOf({ paymentStatus: 'paid' }, 12),
      payments: [auto],
      api: {
        list: vi.fn(async () => ({
          payments: [auto],
          slipPaymentIds: [PAYMENT],
          ...(listed ? { autoConfirmedPaymentIds: [PAYMENT] } : {}),
        })),
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    return env;
  }

  test('it carries the label and the void button is still there', async () => {
    await openAuto(true);
    const note = await screen.findByTestId('auto-confirmed');
    expect(note.textContent).toContain('ยืนยันอัตโนมัติ (Slip2Go) — ตรวจสอบได้ ยกเลิก/คืนเงินได้');
    fireEvent.click(screen.getByRole('button', { name: th['payment.void.button'] }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('a payment staff confirmed has no label', async () => {
    await openAuto(false);
    await screen.findByTestId('paid-card');
    expect(screen.queryByTestId('auto-confirmed')).toBeNull();
  });

  test('the label appears without a reload when the confirmation arrives', async () => {
    const list = vi.fn<() => Promise<OrderPaymentsResponse>>(async () => ({
      payments: [claimed],
      slipPaymentIds: [PAYMENT],
      slipChecks: [{ paymentId: PAYMENT, verify: { verdict: 'valid' as const } }],
    }));
    const env = await setup({
      role: 'manager',
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
    await screen.findByTestId('slip-verify');
    expect(screen.queryByTestId('auto-confirmed')).toBeNull();
    list.mockImplementation(async () => ({
      payments: [auto],
      slipPaymentIds: [PAYMENT],
      autoConfirmedPaymentIds: [PAYMENT],
    }));
    act(() => {
      env.entities.apply({
        type: 'order.upserted',
        id: ORDER,
        rev: 12,
        data: orderOf({ paymentStatus: 'paid' }, 12),
      });
      env.entities.apply({ type: 'payment.upserted', id: auto.id, rev: auto.rev, data: auto });
    });
    expect(await screen.findByTestId('auto-confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: th['payment.void.button'] })).toBeTruthy();
  });
});
