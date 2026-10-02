// @vitest-environment jsdom
import type { PaymentDto } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { settingsFrame } from '../test-support/frames.ts';
import {
  created,
  fixClock,
  loaded,
  methodTile,
  moved,
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

const SIGNATURE = 'SECRETSIGNATURE0123456789abcdefghijklmnopq';
const QR_URL = `https://api.example.test/v1/payments/${PAYMENT}/qr.png?exp=1893456000&sig=${SIGNATURE}`;
const qrLink = (over: Partial<Awaited<ReturnType<ApiClient['payments']['qrUrl']>>> = {}) => ({
  url: QR_URL,
  expiresAt: '2030-10-15T05:05:00.000Z',
  promptpayTargetMasked: '******1234',
  ...over,
});

const pending = (over: Partial<PaymentDto> = {}) =>
  paymentOf({
    method: 'promptpay',
    status: 'pending',
    tenderedSatang: null,
    changeSatang: null,
    confirmedAt: null,
    promptpayTargetMasked: '******1234',
    ...over,
  });
const claimed = (over: Partial<PaymentDto> = {}) =>
  pending({ status: 'claimed', claimedAt: '2030-10-15T04:58:00.000Z', ...over });

const qrImage = () => screen.findByRole('img', { name: /QR พร้อมเพย์/ });
const confirmButton = () => screen.getByRole('button', { name: /ยืนยันรับเงิน/ });

/** Renders the panel for an order that already has a waiting PromptPay payment. */
async function openPayment(
  payment: PaymentDto,
  api: Partial<ApiClient['payments']> = {},
  orderOver: Parameters<typeof orderOf>[0] = {},
) {
  const env = await setup({
    order: orderOf(
      payment.status === 'claimed'
        ? { paymentStatus: 'awaiting_confirmation', ...orderOver }
        : orderOver,
    ),
    payments: [payment],
    api: { qrUrl: vi.fn(async () => qrLink()), ...api },
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return env;
}

/** Chooses PromptPay and taps the start button: the payment is created and the QR shown. */
async function startPromptPay(api: Partial<ApiClient['payments']> = {}) {
  const env = await setup({
    api: {
      create: async () => created(pending(), orderOf({}, 11)),
      qrUrl: vi.fn(async () => qrLink()),
      ...api,
    },
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  fireEvent.click(methodTile(th['payment.method.promptpay']));
  fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
  return env;
}

describe('PromptPay: starting', () => {
  test('choosing it only selects it; the payment is made by the start button, with no amount', async () => {
    const env = await setup({ api: { create: async () => created(pending(), orderOf({}, 11)) } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.promptpay']));
    expect(env.api.payments.create).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: th['payment.start.promptpay'] })).toBeTruthy();
  });

  test('creates a pending PromptPay payment and shows the QR for the server total', async () => {
    const env = await startPromptPay();
    const image = await qrImage();
    expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    const [orderId, input] = env.api.payments.create.mock.calls[0] ?? [];
    expect(orderId).toBe(ORDER);
    expect(input).toEqual({ method: 'promptpay' });
    expect(env.api.payments.qrUrl).toHaveBeenCalledWith(PAYMENT);
    expect(image.getAttribute('src')).toBe(QR_URL);
    expect(image.getAttribute('alt')).not.toContain('sig=');
    expect(screen.getAllByText('฿75.00').length).toBeGreaterThan(0);
  });

  test('shows the masked target from the QR link, so staff can compare it with the bank app', async () => {
    await startPromptPay();
    await qrImage();
    expect(screen.getByText(/\*{6}1234/)).toBeTruthy();
    expect(screen.getByText(th['payment.promptpay.targetHint'])).toBeTruthy();
  });

  test('warns when the ID was changed after the payment was made: the QR pays to the CURRENT one', async () => {
    const env = await setup({
      payments: [pending({ promptpayTargetMasked: '******9999' })],
      api: { qrUrl: async () => qrLink({ promptpayTargetMasked: '******1234' }) },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await qrImage();
    expect(screen.getByText(/ถูกเปลี่ยนหลังสร้างรายการนี้/)).toBeTruthy();
  });

  test('"not configured" tells staff to ask the owner', async () => {
    const env = await setup({
      api: {
        create: async () => {
          throw new ApiClientError('PROMPTPAY_NOT_CONFIGURED', { status: 409 });
        },
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.promptpay']));
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('เจ้าของร้าน');
  });

  test('an unanswered create is unsure and a retry sends the same request id', async () => {
    let calls = 0;
    const env = await setup({
      api: {
        create: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('TIMEOUT');
          return created(pending(), orderOf({}, 11));
        },
        qrUrl: async () => qrLink(),
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.promptpay']));
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
    await screen.findByText(th['payment.unsure']);
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
    await qrImage();
    const ids = env.api.payments.create.mock.calls.map((c) => c[2]?.clientRequestId);
    expect(ids[1]).toBe(ids[0]);
  });

  test('the unsure state ends by itself when the payment arrives through realtime', async () => {
    const env = await setup({
      api: {
        create: async () => {
          throw new ApiClientError('NETWORK');
        },
        qrUrl: async () => qrLink(),
      },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(methodTile(th['payment.method.promptpay']));
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.promptpay'] }));
    await screen.findByText(th['payment.unsure']);
    act(() => {
      env.entities.apply({
        type: 'payment.upserted',
        id: PAYMENT,
        rev: 300,
        data: pending({ rev: 300 }),
      });
    });
    expect(screen.queryByText(th['payment.unsure'])).toBeNull();
    await qrImage();
  });
});

describe('PromptPay: the QR link is a credential', () => {
  test('is fetched again whenever the QR is shown, so a fresh panel asks for a fresh link', async () => {
    const env = await openPayment(pending());
    await qrImage();
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(1);
    cleanup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await qrImage();
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2);
  });

  test('is fetched again when the shop’s PromptPay ID changes', async () => {
    const env = await openPayment(pending());
    await qrImage();
    act(() => {
      env.entities.apply(settingsFrame('promptpay', 500, 2));
    });
    await waitFor(() => expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2));
  });

  test('is fetched again before it expires (a link lives five minutes)', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
    const env = await setup({
      payments: [pending()],
      api: { qrUrl: vi.fn(async () => qrLink()) },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2);
  });

  test('a picture that fails to load (the link expired) gets one new link, then a reload button, never a loop', async () => {
    const env = await openPayment(pending());
    const image = await qrImage();
    fireEvent.error(image);
    await waitFor(() => expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2));
    fireEvent.error(await qrImage());
    expect(await screen.findByText(th['payment.promptpay.qrFailed'])).toBeTruthy();
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.reloadQr'] }));
    await waitFor(() => expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(3));
  });

  test('a picture that loads re-arms the single retry for the next expiry', async () => {
    const env = await openPayment(pending());
    fireEvent.error(await qrImage());
    await waitFor(() => expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2));
    fireEvent.load(await qrImage());
    fireEvent.error(await qrImage());
    await waitFor(() => expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(3));
  });

  test('"not configured" from the link call explains it to staff', async () => {
    await openPayment(pending(), {
      qrUrl: async () => {
        throw new ApiClientError('PROMPTPAY_NOT_CONFIGURED', { status: 409 });
      },
    });
    const alert = await screen.findByText(/เจ้าของร้าน/);
    expect(alert).toBeTruthy();
  });

  test('the link is never logged or stored, and never ends up in the address', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    window.location.hash = '#/orders/x';
    await openPayment(pending());
    const image = await qrImage();
    fireEvent.error(image);
    await qrImage();
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SIGNATURE);
    }
    expect(JSON.stringify({ ...localStorage })).not.toContain(SIGNATURE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SIGNATURE);
    expect(window.location.href).not.toContain(SIGNATURE);
    expect(document.title).not.toContain(SIGNATURE);
    // The only place it appears is the picture's own address.
    expect(document.body.innerHTML.split(SIGNATURE).length - 1).toBe(1);
  });
});

describe('PromptPay: showing it to the customer', () => {
  test('opens a customer view with the big amount and its own fresh QR, and no way to confirm', async () => {
    const env = await openPayment(pending());
    await qrImage();
    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.showCustomer'] }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('฿75.00')).toBeTruthy();
    expect(await within(dialog).findByRole('img', { name: /QR พร้อมเพย์/ })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /ยืนยันรับเงิน/ })).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: th['payment.promptpay.customerSays'] }),
    ).toBeNull();
    // Showing it again asks for another link: one for the staff view, one for this.
    expect(env.api.payments.qrUrl).toHaveBeenCalledTimes(2);
  });

  test('staff come back with Escape, or by holding the button for a second', async () => {
    await openPayment(pending());
    await qrImage();
    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.showCustomer'] }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.showCustomer'] }));
    dialog = await screen.findByRole('dialog');
    const hold = within(dialog).getByRole('button', {
      name: th['payment.promptpay.customer.close'],
    });
    // A quick tap does nothing: a customer touching the screen must not leave this view.
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 });
  });
});

describe('PromptPay: confirming after checking the bank app', () => {
  test('confirm sends the optional reference, and only the server’s answer makes it paid', async () => {
    const env = await openPayment(pending(), {
      confirm: async () =>
        moved(
          paymentOf({
            ...pending(),
            status: 'confirmed',
            confirmedAt: '2030-10-15T05:01:00.000Z',
            referenceNote: '7731',
            rev: 120,
          }),
          orderOf({ paymentStatus: 'paid' }, 12),
        ),
    });
    await qrImage();
    fireEvent.change(screen.getByLabelText(th['payment.reference']), {
      target: { value: ' 7731 ' },
    });
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.confirm).toHaveBeenCalledWith(PAYMENT, { referenceNote: '7731' });
  });

  test('without a reference it sends none', async () => {
    const env = await openPayment(pending(), {
      confirm: async () =>
        moved(
          paymentOf({ ...pending(), status: 'confirmed', rev: 120 }),
          orderOf({ paymentStatus: 'paid' }, 12),
        ),
    });
    await qrImage();
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.confirm).toHaveBeenCalledWith(PAYMENT, {});
  });

  test('says to check the bank app first', async () => {
    await openPayment(pending());
    await qrImage();
    expect(screen.getByText(th['payment.confirmHint'])).toBeTruthy();
  });

  test('nothing is paid until the server answers, and a double tap sends one request', async () => {
    let answer!: () => void;
    const env = await openPayment(pending(), {
      confirm: () =>
        new Promise((resolve) => {
          answer = () =>
            resolve(
              moved(
                paymentOf({ ...pending(), status: 'confirmed', rev: 120 }),
                orderOf({ paymentStatus: 'paid' }, 12),
              ),
            );
        }),
    });
    await qrImage();
    const button = confirmButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(env.api.payments.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
    await act(async () => answer());
    await screen.findByText(th['payment.paid.title']);
  });

  test('a lost answer says so, and the same button can be pressed again', async () => {
    let calls = 0;
    const env = await openPayment(pending(), {
      confirm: async () => {
        calls += 1;
        if (calls === 1) throw new ApiClientError('NETWORK');
        return moved(
          paymentOf({ ...pending(), status: 'confirmed', rev: 120 }),
          orderOf({ paymentStatus: 'paid' }, 12),
        );
      },
    });
    await qrImage();
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.unsureMove']);
    fireEvent.click(confirmButton());
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.confirm).toHaveBeenCalledTimes(2);
  });

  test('a refusal is explained as a payment problem', async () => {
    await openPayment(pending(), {
      confirm: async () => {
        throw new ApiClientError('INVALID_TRANSITION', { status: 409 });
      },
    });
    await qrImage();
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(th['error.paymentInvalidTransition']);
  });

  test('the app stays busy while a payment is waiting', async () => {
    const env = await openPayment(pending());
    await qrImage();
    expect(env.activity.isBusy()).toBe(true);
  });
});

describe('PromptPay: the customer says they paid', () => {
  test('"customer says paid" claims it; the QR goes away and the check-the-bank steps stay', async () => {
    const env = await openPayment(pending(), {
      claim: async () =>
        moved(claimed({ rev: 120 }), orderOf({ paymentStatus: 'awaiting_confirmation' }, 12)),
    });
    await qrImage();
    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.customerSays'] }));
    await screen.findByText(th['payment.claimed']);
    expect(env.api.payments.claim).toHaveBeenCalledWith(PAYMENT, {});
    expect(screen.queryByRole('img', { name: /QR พร้อมเพย์/ })).toBeNull();
    // A claim never confirms: staff still confirm by hand.
    expect(confirmButton()).toBeTruthy();
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
  });

  test('a payment claimed by the customer (from LINE) shows as to-check with confirm and "not found"', async () => {
    const env = await openPayment(claimed());
    expect(screen.getByText(th['payment.claimed'])).toBeTruthy();
    expect(confirmButton()).toBeTruthy();
    expect(screen.getByRole('button', { name: th['payment.promptpay.notFound'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.promptpay.customerSays'] })).toBeNull();
    // No QR is made for a claim.
    expect(env.api.payments.qrUrl).not.toHaveBeenCalled();
  });

  test('a claim arriving by realtime turns a waiting payment into one to check', async () => {
    const env = await openPayment(pending());
    await qrImage();
    act(() => {
      env.entities.apply({
        type: 'payment.upserted',
        id: PAYMENT,
        rev: 400,
        data: claimed({ rev: 400 }),
      });
    });
    expect(screen.getByText(th['payment.claimed'])).toBeTruthy();
  });

  test('"money not found" needs a reason, cancels the claim, and the methods come back', async () => {
    const env = await openPayment(claimed(), {
      cancelClaimed: async () =>
        moved(
          paymentOf({ ...claimed(), status: 'cancelled', reason: 'ไม่พบยอด', rev: 130 }),
          orderOf({ paymentStatus: 'unpaid' }, 13),
        ),
    });
    fireEvent.click(screen.getByRole('button', { name: th['payment.promptpay.notFound'] }));
    const dialog = screen.getByRole('dialog');
    const send = within(dialog).getByRole('button', {
      name: th['payment.notFound.confirm'],
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(th['payment.notFound.reason']), {
      target: { value: ' ไม่พบยอด ' },
    });
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.api.payments.cancelClaimed).toHaveBeenCalledWith(PAYMENT, { reason: 'ไม่พบยอด' });
    expect(methodTile(th['payment.method.cash'])).toBeTruthy();
  });

  test('a cashier without that permission would not see the button (the machine decides)', async () => {
    const env = await setup({
      role: 'kitchen',
      payments: [claimed()],
      order: orderOf({ paymentStatus: 'awaiting_confirmation' }),
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    expect(screen.queryByRole('button', { name: th['payment.promptpay.notFound'] })).toBeNull();
  });
});
