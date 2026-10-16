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
} from '../../test-support/payment-env.tsx';
import { renderScreen } from '../../test-support/render.tsx';
import { PaymentPanel } from '../payments/PaymentPanel.tsx';
import { SlipView } from './SlipView.tsx';

// The automatic reading of the slip (D-26) is a HINT: a banner, a chip and, unless the receiver and
// the amount both match and the slip is new, a tick "I checked the bank app" before confirm enables.
// It never confirms money by itself (rule 2); the tick is sent to the server only for the audit row.

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
  hasSlip = true,
) {
  const confirm = vi.fn(async () => ({
    payment: confirmedPayment,
    order: orderOf({ paymentStatus: 'paid' }),
  }));
  const list = vi.fn(async () => ({
    payments: [claimed],
    slipPaymentIds: hasSlip ? [PAYMENT] : [],
    ...(check && hasSlip
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

const tick = () => screen.getByRole('checkbox', { name: th['payment.bankCheck.label'] });
const noTick = () => screen.queryByRole('checkbox', { name: th['payment.bankCheck.label'] });

describe('confirming', () => {
  test('receiver and amount both match and the slip is new: one tap, no tick, nothing extra sent', async () => {
    const { confirm } = await open('match', 7500, undefined, true, 'match');
    await screen.findByTestId('slip-check');
    expect(noTick()).toBeNull();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(PAYMENT, {});
  });

  test.each([
    ['the receiver is unknown', 'match', 7500, 'unknown'],
    ['the receiver is not checked', 'match', 7500, undefined],
    ['the receiver differs', 'match', 7500, 'mismatch'],
    ['the amount differs', 'mismatch', 6000, 'match'],
    ['the amount is unreadable', 'unreadable', null, 'match'],
    ['the amount is still being read', 'pending', null, 'match'],
    ['there is no reading at all', null, null, undefined],
  ] as const)(
    '%s: confirm stays off until the tick, then one tap sends the tick',
    async (_n, check, amount, recipient) => {
      const { confirm } = await open(check, amount, undefined, undefined, recipient);
      await screen.findByTestId('slip-has');
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(th['payment.bankCheck.hint'])).toBeTruthy();
      fireEvent.click(confirmButton());
      expect(confirm).not.toHaveBeenCalled();
      fireEvent.click(tick());
      expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(confirmButton());
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(confirm).toHaveBeenCalledWith(PAYMENT, { attestedBankCheck: true });
    },
  );

  test('unticking turns confirm off again', async () => {
    await open('match', 7500, undefined, true, 'unknown');
    await screen.findByTestId('slip-has');
    fireEvent.click(tick());
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tick());
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test("a payment with no slip keeps today's flow: no tick, one tap", async () => {
    const { confirm } = await open(null, null, undefined, undefined, undefined, false);
    await screen.findByTestId('slip-missing');
    expect(noTick()).toBeNull();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(PAYMENT, {});
  });

  test('the reference typed by staff goes with the tick', async () => {
    const { confirm } = await open('mismatch', 6000, undefined, true, 'match');
    await screen.findByTestId('slip-check');
    fireEvent.change(screen.getByLabelText(th['payment.reference']), { target: { value: 'R-1' } });
    fireEvent.click(tick());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(PAYMENT, {
      referenceNote: 'R-1',
      attestedBankCheck: true,
    });
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

  test('a duplicate needs the tick even when the amount and the receiver match', async () => {
    const { confirm } = await open(
      'match',
      7500,
      { orderNo: 'L-012', paymentStatus: 'claimed' },
      true,
      'match',
    );
    await screen.findByTestId('slip-duplicate');
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tick());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(PAYMENT, { attestedBankCheck: true });
  });

  test('with every warning at once, one tick is still the only extra step', async () => {
    const { confirm } = await open(
      'mismatch',
      6000,
      { orderNo: 'L-012', paymentStatus: 'claimed' },
      true,
      'mismatch',
    );
    await screen.findByTestId('slip-duplicate');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(tick());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  });
});

describe('the receiver on the slip (an automatic hint)', () => {
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
});

describe('what the slip view reports to the payment screen', () => {
  const report = async (list: () => Promise<unknown>) => {
    const onCheck = vi.fn();
    const env = await setup({ api: { list: list as never } });
    renderScreen(
      <SlipView
        orderId={ORDER}
        paymentId={PAYMENT}
        rev={1}
        amountSatang={7500}
        onCheck={onCheck}
      />,
      env.services,
    );
    await waitFor(() => expect(onCheck).toHaveBeenCalled());
    return onCheck;
  };

  test('the readings and the duplicate flag, as the server gave them', async () => {
    const onCheck = await report(async () => ({
      payments: [claimed],
      slipPaymentIds: [PAYMENT],
      slipChecks: [
        { paymentId: PAYMENT, check: 'match', amountSatang: 7500, recipientCheck: 'unknown' },
      ],
      slipDuplicates: [{ paymentId: PAYMENT, orderNo: 'L-1', paymentStatus: 'claimed' }],
    }));
    expect(onCheck).toHaveBeenLastCalledWith({
      hasSlip: true,
      check: 'match',
      recipient: 'unknown',
      duplicate: true,
      verdict: null,
    });
  });

  test('no slip on the payment', async () => {
    const onCheck = await report(async () => ({ payments: [claimed], slipPaymentIds: [] }));
    expect(onCheck).toHaveBeenLastCalledWith({
      hasSlip: false,
      check: null,
      recipient: null,
      verdict: null,
      duplicate: false,
    });
  });

  test('a list that cannot be read counts as a slip nobody verified (fail closed)', async () => {
    const onCheck = await report(async () => {
      throw new Error('offline');
    });
    expect(onCheck).toHaveBeenLastCalledWith({
      hasSlip: true,
      check: null,
      recipient: null,
      duplicate: false,
    });
  });
});
