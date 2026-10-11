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
async function open(
  check: SlipCheck | null,
  amountSatang: number | null = null,
  duplicate?: {
    orderNo: string;
    paymentStatus: 'claimed' | 'confirmed';
    matchedBy?: 'qr' | 'ref' | 'image';
  },
  qrFound?: boolean,
  recipientCheck?: 'match' | 'mismatch' | 'unknown',
) {
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
              ...(qrFound === undefined ? {} : { qrFound }),
              ...(recipientCheck === undefined ? {} : { recipientCheck }),
            },
          ],
        }
      : {}),
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

describe('a slip that was used before (an automatic hint)', () => {
  test('a strong red banner above the amount banner names the order and its status, and says it is automatic', async () => {
    await open('mismatch', 6000, { orderNo: 'L-012', paymentStatus: 'confirmed' });
    const banner = await screen.findByTestId('slip-duplicate');
    expect(banner.textContent).toContain('สลิปนี้เคยใช้แล้วกับออเดอร์ L-012 (สถานะ รับเงินแล้ว)');
    expect(banner.textContent).toContain(th['payment.slip.check.hint']);
    // Above the amount banner.
    const amount = screen.getByTestId('slip-check');
    expect(banner.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A chip beside the slip note, and the picture button is still there.
    expect((await screen.findByTestId('slip-duplicate-chip')).textContent).toContain(
      th['payment.slip.chip.duplicate'],
    );
    expect(screen.getByRole('button', { name: th['payment.slip.view'] })).toBeTruthy();
  });

  test('it shows even when there is no amount reading (the reading is off)', async () => {
    await open(null, null, { orderNo: 'L-003', paymentStatus: 'claimed' });
    expect(await screen.findByTestId('slip-duplicate')).toBeTruthy();
    expect(screen.queryByTestId('slip-check')).toBeNull();
  });

  test('a match by the QR on the slip says so', async () => {
    await open(
      'match',
      7500,
      { orderNo: 'L-012', paymentStatus: 'claimed', matchedBy: 'qr' },
      true,
    );
    expect((await screen.findByTestId('slip-duplicate')).textContent).toContain(
      'รหัสอ้างอิงในคิวอาร์สลิปตรงกับสลิปเดิม ออเดอร์ L-012 (สถานะ รอตรวจสอบ)',
    );
  });

  test('no QR on the slip is a quiet note, not an alarm; a QR or no reading shows none', async () => {
    await open('match', 7500, undefined, false);
    const note = await screen.findByTestId('slip-no-qr');
    expect(note.textContent).toContain('ไม่พบคิวอาร์บนสลิป');
    expect(note.getAttribute('role')).toBeNull();
    expect(screen.queryByTestId('slip-duplicate')).toBeNull();
  });

  test('a slip with a QR shows no note', async () => {
    await open('match', 7500, undefined, true);
    await screen.findByTestId('slip-check');
    expect(screen.queryByTestId('slip-no-qr')).toBeNull();
  });

  test('no duplicate: no red banner and no chip', async () => {
    await open('match', 7500);
    await screen.findByTestId('slip-check');
    expect(screen.queryByTestId('slip-duplicate')).toBeNull();
    expect(screen.queryByTestId('slip-duplicate-chip')).toBeNull();
  });

  test('the first tap on confirm only asks again, the second confirms (even with a matching amount)', async () => {
    const { confirm } = await open('match', 7500, { orderNo: 'L-012', paymentStatus: 'claimed' });
    await screen.findByTestId('slip-duplicate');
    fireEvent.click(confirmButton());
    expect(confirm).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByRole('alert')
        .map((x) => x.textContent)
        .join(' '),
    ).toContain(th['payment.confirmDuplicateWarn']);
    expect(confirmButton().textContent).toContain('สลิปซ้ำ');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });

  test('with a mismatch too, both warnings show and one extra tap still confirms', async () => {
    const { confirm } = await open('mismatch', 6000, {
      orderNo: 'L-012',
      paymentStatus: 'claimed',
    });
    await screen.findByTestId('slip-duplicate');
    fireEvent.click(confirmButton());
    expect(confirm).not.toHaveBeenCalled();
    const text = screen
      .getAllByRole('alert')
      .map((a) => a.textContent)
      .join(' ');
    expect(text).toContain(th['payment.confirmDuplicateWarn']);
    expect(text).toContain(th['payment.confirmMismatchWarn']);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });
});

describe('the receiver on the slip (an automatic hint)', () => {
  const alerts = () =>
    screen
      .getAllByRole('alert')
      .map((a) => a.textContent)
      .join(' ');

  test('a receiver that does not match is a red banner that says the money may have gone to someone else', async () => {
    await open('match', 7500, undefined, true, 'mismatch');
    const banner = await screen.findByTestId('slip-recipient');
    expect(banner.getAttribute('data-recipient')).toBe('mismatch');
    expect(banner.textContent).toContain(
      'ผู้รับบนสลิปดูไม่ตรงกับบัญชีร้าน — อาจโอนให้คนอื่น ตรวจในแอปธนาคารของร้าน',
    );
    expect(banner.textContent).toContain(th['payment.slip.check.hint']);
    expect((await screen.findByTestId('slip-recipient-chip')).textContent).toContain(
      th['payment.slip.recipient.chip.mismatch'],
    );
    // The fake-slip warning and the picture button are still there.
    expect(screen.getByRole('button', { name: th['payment.slip.view'] })).toBeTruthy();
  });

  test('an unknown receiver is a small neutral note, not an alarm', async () => {
    await open('match', 7500, undefined, true, 'unknown');
    const note = await screen.findByTestId('slip-recipient');
    expect(note.textContent).toContain(th['payment.slip.recipient.unknown']);
    expect(note.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('slip-recipient-chip')).toBeNull();
  });

  test('a matching receiver is a small green chip that says it is automatic, with no banner', async () => {
    await open('match', 7500, undefined, true, 'match');
    const chip = await screen.findByTestId('slip-recipient-chip');
    expect(chip.textContent).toContain(th['payment.slip.recipient.chip.match']);
    expect(chip.className).toContain('g-b-ok');
    expect(screen.queryByTestId('slip-recipient')).toBeNull();
  });

  test('no receiver reading: nothing about the receiver', async () => {
    await open('match', 7500, undefined, true);
    await screen.findByTestId('slip-check');
    expect(screen.queryByTestId('slip-recipient')).toBeNull();
    expect(screen.queryByTestId('slip-recipient-chip')).toBeNull();
  });

  test.each(['match', 'unknown'] as const)('with %s one tap confirms, as before', async (value) => {
    const { confirm } = await open('match', 7500, undefined, true, value);
    await screen.findByTestId('slip-check');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });

  test('on a mismatch the first tap only asks again (even with a matching amount), the second confirms', async () => {
    const { confirm } = await open('match', 7500, undefined, true, 'mismatch');
    await screen.findByTestId('slip-recipient');
    fireEvent.click(confirmButton());
    expect(confirm).not.toHaveBeenCalled();
    expect(alerts()).toContain(th['payment.confirmRecipientWarn']);
    expect(confirmButton().textContent).toContain('ผู้รับบนสลิปไม่ตรง');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });

  test('with a duplicate and an amount mismatch too, every warning shows and one extra tap still confirms', async () => {
    const { confirm } = await open(
      'mismatch',
      6000,
      { orderNo: 'L-012', paymentStatus: 'claimed' },
      true,
      'mismatch',
    );
    await screen.findByTestId('slip-recipient');
    fireEvent.click(confirmButton());
    expect(confirm).not.toHaveBeenCalled();
    const text = alerts();
    expect(text).toContain(th['payment.confirmDuplicateWarn']);
    expect(text).toContain(th['payment.confirmMismatchWarn']);
    expect(text).toContain(th['payment.confirmRecipientWarn']);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });
});
