// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { orderDto, paymentFrame, uuid } from '../../test-support/frames.ts';
import { createTestServices, renderScreen } from '../../test-support/render.tsx';
import { StateBadge } from './list-parts.tsx';

const tr = translator('th');
afterEach(cleanup);

function show(
  order: Parameters<typeof orderDto>[2],
  payments: Parameters<typeof paymentFrame>[3][] = [],
) {
  const env = createTestServices();
  payments.forEach((over, i) => {
    env.entities.apply(paymentFrame(uuid(600 + i), uuid(1), 10 + i, over));
  });
  renderScreen(<StateBadge order={orderDto(uuid(1), 1, order)} />, env.services);
}

describe('the payment badge of an order in the list', () => {
  test('a new unpaid LINE PromptPay order says "waiting for payment", muted', () => {
    show({ channel: 'line', paymentMethod: 'promptpay' });
    expect(screen.getByText(tr('orders.flag.awaitingPay'))).toBeTruthy();
    expect(screen.queryByText(tr('status.payment.unpaid'))).toBeNull();
  });

  test('an older server (no method on the order) is read from the payments on the device', () => {
    show({ channel: 'line', paymentMethod: undefined }, [
      { method: 'promptpay', status: 'pending' },
    ]);
    expect(screen.getByText(tr('orders.flag.awaitingPay'))).toBeTruthy();
    expect(screen.queryByText(tr('status.payment.unpaid'))).toBeNull();
  });

  test('a LINE cash order keeps its normal unpaid badge', () => {
    show({ channel: 'line', paymentMethod: 'cash' }, [{ method: 'cash', status: 'pending' }]);
    expect(screen.queryByText(tr('orders.flag.awaitingPay'))).toBeNull();
    expect(screen.getByText(tr('status.payment.unpaid'))).toBeTruthy();
  });

  test('a storefront order never says waiting for payment', () => {
    show({ channel: 'storefront', paymentMethod: 'promptpay' });
    expect(screen.queryByText(tr('orders.flag.awaitingPay'))).toBeNull();
  });

  test('the server flag shows the confirm-by-hand icon with its reason', () => {
    show({ channel: 'line', paymentStatus: 'awaiting_confirmation', needsManualConfirm: true });
    const flag = screen.getByText(tr('orders.flag.manualConfirm'));
    expect(flag.closest('[title]')?.getAttribute('title')).toBe(
      tr('orders.flag.manualConfirmHint'),
    );
    expect(screen.getByText(tr('status.payment.awaiting_confirmation'))).toBeTruthy();
  });

  test('a claim the server did not flag (still being checked) shows no icon', () => {
    show({
      channel: 'line',
      paymentStatus: 'awaiting_confirmation',
      claimWithoutSlip: false,
      needsManualConfirm: false,
    });
    expect(screen.queryByText(tr('orders.flag.manualConfirm'))).toBeNull();
  });

  test('an older server (no flag) falls back to a claim with a slip that is not confirmed', () => {
    show({
      channel: 'line',
      paymentStatus: 'awaiting_confirmation',
      claimWithoutSlip: false,
      needsManualConfirm: undefined,
    });
    expect(screen.getByText(tr('orders.flag.manualConfirm'))).toBeTruthy();
  });

  test('a claim without a slip shows its own flag and not the confirm-by-hand one', () => {
    show({ paymentStatus: 'awaiting_confirmation', claimWithoutSlip: true });
    expect(screen.getByText(tr('orders.flag.noSlip'))).toBeTruthy();
    expect(screen.queryByText(tr('orders.flag.manualConfirm'))).toBeNull();
  });

  test('a cancelled order shows only that', () => {
    show({
      channel: 'line',
      status: 'cancelled',
      paymentStatus: 'awaiting_confirmation',
      claimWithoutSlip: false,
      needsManualConfirm: true,
    });
    expect(screen.queryByText(tr('orders.flag.manualConfirm'))).toBeNull();
  });

  test('the waiting badge works from the order method alone, with no payment on the device', () => {
    show({ channel: 'line', paymentMethod: 'promptpay' });
    expect(screen.getByText(tr('orders.flag.awaitingPay'))).toBeTruthy();
  });
});
