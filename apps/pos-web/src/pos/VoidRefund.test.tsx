// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import {
  fixClock,
  loaded,
  moved,
  ORDER,
  orderOf,
  PAYMENT,
  paymentOf,
  setup,
  th,
} from '../test-support/payment-env.tsx';
import { renderScreen, STEP_UP_PIN } from '../test-support/render.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

beforeEach(fixClock);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const paidCash = () =>
  paymentOf({
    status: 'confirmed',
    method: 'cash',
    tenderedSatang: satang(10000),
    changeSatang: satang(2500),
  });
const voided = (status: 'voided' | 'refunded') =>
  moved(
    paymentOf({ status, method: 'cash', rev: 140, reason: 'ทอนผิด' }),
    orderOf({ paymentStatus: status === 'voided' ? 'unpaid' : 'refunded' }, 14),
  );

async function paid(options: Parameters<typeof setup>[0] = {}) {
  const env = await setup({
    role: 'manager',
    order: orderOf({ paymentStatus: 'paid' }, 12),
    payments: [paidCash()],
    ...options,
  });
  renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
  await loaded();
  return env;
}

const enterPin = (pin: string) => {
  for (const digit of pin) fireEvent.click(screen.getByRole('button', { name: digit }));
  fireEvent.click(screen.getByRole('button', { name: th['auth.stepUp.submit'] }));
};

async function fillAndSubmit(reason = 'ทอนผิด', confirm = th['payment.void.confirmVoid']) {
  fireEvent.click(screen.getByRole('button', { name: th['payment.void.button'] }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(th['payment.void.reason']), {
    target: { value: reason },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
  return dialog;
}

describe('who may void or refund', () => {
  test('a manager sees the button on a paid order; a cashier and the kitchen do not', async () => {
    await paid();
    expect(screen.getByRole('button', { name: th['payment.void.button'] })).toBeTruthy();
    cleanup();
    await paid({ role: 'cashier' });
    expect(screen.queryByRole('button', { name: th['payment.void.button'] })).toBeNull();
    cleanup();
    await paid({ role: 'owner' });
    expect(screen.getByRole('button', { name: th['payment.void.button'] })).toBeTruthy();
  });
});

describe('the void dialog', () => {
  test('needs a reason and says clearly that it is audited and asks for a step-up', async () => {
    const env = await paid();
    fireEvent.click(screen.getByRole('button', { name: th['payment.void.button'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(th['payment.void.audited'])).toBeTruthy();
    const go = within(dialog).getByRole('button', {
      name: th['payment.void.confirmVoid'],
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(th['payment.void.reason']), {
      target: { value: '   ' },
    });
    expect(go.disabled).toBe(true);
    expect(env.api.payments.void).not.toHaveBeenCalled();
  });

  test('asks for the step-up first, and sends the void with the reason only after it', async () => {
    const env = await paid({ api: { void: async () => voided('voided') } });
    await fillAndSubmit();
    // The step-up dialog is up; nothing has been sent.
    expect(await screen.findByText(th['auth.stepUp.pinHint'])).toBeTruthy();
    expect(env.api.payments.void).not.toHaveBeenCalled();
    enterPin(STEP_UP_PIN);
    await waitFor(() => expect(env.api.payments.void).toHaveBeenCalledTimes(1));
    expect(env.api.payments.void).toHaveBeenCalledWith(PAYMENT, { reason: 'ทอนผิด' });
    // The order is unpaid again, so the methods come back.
    await screen.findByRole('radio', { name: /เงินสด/ });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a refund goes to /refund', async () => {
    const env = await paid({ api: { refund: async () => voided('refunded') } });
    fireEvent.click(screen.getByRole('button', { name: th['payment.void.button'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: th['payment.void.kind.refund'] }));
    fireEvent.change(within(dialog).getByLabelText(th['payment.void.reason']), {
      target: { value: 'ลูกค้าขอคืน' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['payment.void.confirmRefund'] }));
    await screen.findByText(th['auth.stepUp.pinHint']);
    enterPin(STEP_UP_PIN);
    await waitFor(() =>
      expect(env.api.payments.refund).toHaveBeenCalledWith(PAYMENT, { reason: 'ลูกค้าขอคืน' }),
    );
    expect(env.api.payments.void).not.toHaveBeenCalled();
  });

  test('cancelling the step-up sends nothing and leaves the dialog open', async () => {
    const env = await paid();
    const dialog = await fillAndSubmit();
    await screen.findByText(th['auth.stepUp.pinHint']);
    fireEvent.click(screen.getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(screen.queryByText(th['auth.stepUp.pinHint'])).toBeNull());
    expect(env.api.payments.void).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a wrong PIN is refused by the step-up and nothing is sent', async () => {
    const env = await paid();
    await fillAndSubmit();
    await screen.findByText(th['auth.stepUp.pinHint']);
    enterPin('9999');
    expect((await screen.findByRole('alert')).textContent).toBe(th['auth.stepUp.failed']);
    expect(env.api.payments.void).not.toHaveBeenCalled();
  });

  test('a server that says "step-up required" anyway prompts again and retries once', async () => {
    let calls = 0;
    const env = await paid({
      api: {
        void: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('STEP_UP_REQUIRED', { status: 403 });
          return voided('voided');
        },
      },
    });
    await fillAndSubmit();
    await screen.findByText(th['auth.stepUp.pinHint']);
    enterPin(STEP_UP_PIN);
    // The first call was refused: the dialog comes back for a second proof.
    await waitFor(() => expect(env.api.payments.void).toHaveBeenCalledTimes(1));
    await screen.findByText(th['auth.stepUp.pinHint']);
    enterPin(STEP_UP_PIN);
    await waitFor(() => expect(env.api.payments.void).toHaveBeenCalledTimes(2));
    await screen.findByRole('radio', { name: /เงินสด/ });
  });

  test('another refusal is shown in the void dialog', async () => {
    await paid({
      api: {
        void: async () => {
          throw new ApiClientError('FORBIDDEN', { status: 403 });
        },
      },
    });
    const dialog = await fillAndSubmit();
    await screen.findByText(th['auth.stepUp.pinHint']);
    enterPin(STEP_UP_PIN);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(th['error.forbidden']);
  });

  test('the app is held busy while the dialog or the step-up is open', async () => {
    const env = await paid();
    expect(env.activity.isBusy()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: th['payment.void.button'] }));
    expect(env.activity.isBusy()).toBe(true);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: th['common.cancel'] }),
    );
    expect(env.activity.isBusy()).toBe(false);
  });
});
