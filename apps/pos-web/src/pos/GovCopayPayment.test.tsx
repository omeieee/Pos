// @vitest-environment jsdom
import { formatDate } from '@sds/i18n';
import type { PaymentDto } from '@sds/shared';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { govCopayFrame } from '../test-support/frames.ts';
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
});

const pending = (over: Partial<PaymentDto> = {}) =>
  paymentOf({
    method: 'gov_copay',
    status: 'pending',
    tenderedSatang: null,
    changeSatang: null,
    confirmedAt: null,
    schemeId: '0192f3a0-0000-7000-8000-000000000077',
    estGovShareSatang: satang(4500),
    estCustomerShareSatang: satang(3000),
    ...over,
  });

async function panel(options: Parameters<typeof setup>[0] = {}) {
  const env = await setup({ frames: [govCopayFrame(6)], ...options });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return env;
}

describe('ไทยช่วยไทย: the option', () => {
  test('is on offer inside the scheme, with its end date and "storefront only"', async () => {
    await panel();
    const tile = methodTile(th['payment.method.gov_copay']) as HTMLInputElement;
    expect(tile.disabled).toBe(false);
    const sub = th['payment.method.govCopaySub'].replace(
      '{date}',
      formatDate('2030-11-30', 'th', 'date'),
    );
    expect(screen.getByText(sub)).toBeTruthy();
  });

  test('is disabled WITH its reason outside the scheme hours, never silently gone', async () => {
    // 23:30 in Bangkok: the scheme closes at 23:00.
    vi.setSystemTime(new Date('2030-10-15T16:30:00Z'));
    await panel();
    const tile = methodTile(th['payment.method.gov_copay']) as HTMLInputElement;
    expect(tile.disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.outsideWindow'])).toBeTruthy();
  });

  test('switches itself off when the window closes while the panel stays open', async () => {
    // Timers are faked too, so the tick can be advanced; `waitFor` would hang, hence act().
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    // 22:59:50 in Bangkok: ten seconds before the scheme closes.
    vi.setSystemTime(new Date('2030-10-15T15:59:50Z'));
    const env = await setup({ frames: [govCopayFrame(6)] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const tile = () => methodTile(th['payment.method.gov_copay']) as HTMLInputElement;
    expect(tile().disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(tile().disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.outsideWindow'])).toBeTruthy();
  });

  test('is disabled after the scheme’s last day', async () => {
    vi.setSystemTime(new Date('2030-12-01T05:00:00Z'));
    await panel();
    expect((methodTile(th['payment.method.gov_copay']) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.outsideWindow'])).toBeTruthy();
  });

  test('is never offered for room delivery', async () => {
    await panel({ order: orderOf({ fulfillment: 'room_delivery', roomNo: '1204' }) });
    expect((methodTile(th['payment.method.gov_copay']) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.notAtCounter'])).toBeTruthy();
  });

  test('is never offered for a Grab order', async () => {
    await panel({ order: orderOf({ channel: 'grab', fulfillment: 'platform_delivery' }) });
    expect((methodTile(th['payment.method.gov_copay']) as HTMLInputElement).disabled).toBe(true);
  });

  test('says it is switched off, or not set up', async () => {
    await panel({ frames: [govCopayFrame(6, { enabled: false })] });
    expect(screen.getByText(th['payment.copay.reason.off'])).toBeTruthy();
    cleanup();
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.getByText(th['payment.copay.reason.notConfigured'])).toBeTruthy();
  });

  test('a disabled option cannot be chosen', async () => {
    await panel({ order: orderOf({ fulfillment: 'room_delivery', roomNo: '1204' }) });
    fireEvent.click(methodTile(th['payment.method.gov_copay']));
    expect(screen.queryByRole('button', { name: th['payment.start.gov_copay'] })).toBeNull();
  });
});

describe('ไทยช่วยไทย: the guided steps', () => {
  async function chosen(options: Parameters<typeof setup>[0] = {}) {
    const env = await panel(options);
    fireEvent.click(methodTile(th['payment.method.gov_copay']));
    return env;
  }

  test('shows the FULL server amount to type into ถุงเงิน, in big type', async () => {
    await chosen();
    expect(screen.getByText(th['payment.govCopay.typeAmount'])).toBeTruthy();
    const big = screen.getByText('฿75.00', { selector: '.amount-hero--typed' });
    expect(big).toBeTruthy();
  });

  test('shows the split as an ESTIMATE, labelled so, from the shared calculation', async () => {
    await chosen();
    expect(screen.getByText(th['payment.govCopay.estimateLabel'])).toBeTruthy();
    expect(screen.getByText('฿45.00')).toBeTruthy();
    expect(screen.getByText('฿30.00')).toBeTruthy();
    expect(screen.getByText(th['payment.govCopay.govShare'])).toBeTruthy();
    expect(screen.getByText(th['payment.govCopay.customerShare'])).toBeTruthy();
  });

  test('says when the estimate was cut back to the daily cap', async () => {
    await chosen({ order: orderOf({ totalSatang: satang(50000) }) });
    // 60% of ฿500 is ฿300, cut to the ฿200 daily cap.
    expect(screen.getByText('฿200.00', { selector: '.copay__figure' })).toBeTruthy();
    expect(screen.getByText(th['payment.govCopay.capped'])).toBeTruthy();
  });

  test('keeps the capped note once the payment exists, with the server’s own figures', async () => {
    await panel({
      order: orderOf({ totalSatang: satang(50000) }),
      payments: [
        pending({
          amountSatang: satang(50000),
          estGovShareSatang: satang(20000),
          estCustomerShareSatang: satang(30000),
        }),
      ],
    });
    const section = screen.getByRole('region', { name: th['payment.govCopay.title'] });
    expect(within(section).getByText('฿200.00', { selector: '.copay__figure' })).toBeTruthy();
    expect(within(section).getByText(th['payment.govCopay.capped'])).toBeTruthy();
  });

  test('tells staff to create the ถุงเงิน QR themselves: this app never makes or sends it', async () => {
    await chosen();
    expect(screen.getByText(th['payment.govCopay.noQr'])).toBeTruthy();
    expect(screen.getByText(th['payment.govCopay.step2Hint'])).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/สร้าง QR ยอด/)).toBeTruthy();
  });

  test('the payment is made only by the start button, with no amount', async () => {
    const env = await chosen({
      api: { create: async () => created(pending(), orderOf({}, 11)) },
    });
    expect(env.api.payments.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.gov_copay'] }));
    await screen.findByLabelText(th['payment.govCopay.reference']);
    expect(env.api.payments.create).toHaveBeenCalledTimes(1);
    expect(env.api.payments.create.mock.calls[0]?.[1]).toEqual({ method: 'gov_copay' });
  });

  test('once started, shows the server’s own estimate and takes an optional ถุงเงิน reference', async () => {
    const env = await panel({
      payments: [
        pending({ estGovShareSatang: satang(4501), estCustomerShareSatang: satang(2999) }),
      ],
      api: {
        confirm: async () =>
          moved(pending({ status: 'confirmed', rev: 120 }), orderOf({ paymentStatus: 'paid' }, 12)),
      },
    });
    const section = screen.getByRole('region', { name: th['payment.govCopay.title'] });
    expect(within(section).getByText('฿45.01')).toBeTruthy();
    expect(within(section).getByText('฿29.99')).toBeTruthy();
    expect(within(section).getByText(th['payment.govCopay.estimateLabel'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(th['payment.govCopay.reference']), {
      target: { value: 'TN-5521' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ยืนยันรับเงิน/ }));
    await screen.findByText(th['payment.paid.title']);
    expect(env.api.payments.confirm).toHaveBeenCalledWith(PAYMENT, { referenceNote: 'TN-5521' });
  });

  test('has no "customer says paid" button: the customer pays in front of the cashier', async () => {
    await panel({ payments: [pending()] });
    expect(screen.queryByRole('button', { name: th['payment.promptpay.customerSays'] })).toBeNull();
  });

  test('a refusal from the server (the scheme closed meanwhile) shows its reason', async () => {
    await chosen({
      api: {
        create: async () => {
          throw new ApiClientError('GOV_COPAY_UNAVAILABLE', { status: 422 });
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: th['payment.start.gov_copay'] }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(th['error.govCopayUnavailable']);
  });
});
