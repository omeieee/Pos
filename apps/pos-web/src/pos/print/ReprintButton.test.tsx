// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { OrderStatus, PrintJobDto, StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { uuid } from '../../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { ReprintButton } from './ReprintButton.tsx';

afterEach(cleanup);
const tr = translator('th');
const ORDER = uuid(900);

const job = (seq: number): PrintJobDto => ({
  id: uuid(500 + seq),
  orderId: ORDER,
  orderNo: 'S-013',
  kind: 'reprint',
  seq,
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2030-10-15T05:00:00.000Z',
  printedAt: null,
});

async function open(
  role: StaffRole,
  reprint: (...a: never[]) => unknown,
  offline = false,
  status: OrderStatus = 'ready',
) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({
    auth,
    print: { reprint: reprint as never },
    ...(offline ? { offline: true } : {}),
  });
  renderScreen(<ReprintButton orderId={ORDER} status={status} />, env.services);
  return env;
}
const button = () => screen.queryByRole('button', { name: tr('print.reprint.button') });

describe('who sees it', () => {
  test.each(['cashier', 'manager', 'owner'] as const)('%s has the button', async (role) => {
    await open(role, async () => ({ job: job(1), replay: false }));
    expect(button()).not.toBeNull();
  });

  test('a cancelled order has none', async () => {
    await open('cashier', async () => ({ job: job(1), replay: false }), false, 'cancelled');
    expect(button()).toBeNull();
  });

  test('the kitchen has none', async () => {
    await open('kitchen', async () => ({ job: job(1), replay: false }));
    expect(button()).toBeNull();
  });
});

describe('reprinting', () => {
  test('one tap sends one request with an idempotency key and confirms with the copy number', async () => {
    const env = await open('cashier', async () => ({ job: job(2), replay: false }));
    fireEvent.click(button() as HTMLElement);
    expect(await screen.findByText(tr('print.reprint.done', { seq: 2 }))).toBeTruthy();
    expect(env.api.print.reprint).toHaveBeenCalledTimes(1);
    expect(env.api.print.reprint).toHaveBeenCalledWith(
      ORDER,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  test('a double tap sends one request and the button is disabled meanwhile', async () => {
    let finish!: () => void;
    const env = await open(
      'cashier',
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ job: job(1), replay: false });
        }),
    );
    fireEvent.click(button() as HTMLElement);
    const busy = (await screen.findByRole('button', {
      name: tr('print.reprint.sending'),
    })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(env.api.print.reprint).toHaveBeenCalledTimes(1);
    finish();
    await screen.findByText(tr('print.reprint.done', { seq: 1 }));
  });

  test('PRINTING_OFF says printing is off in Settings', async () => {
    await open('cashier', async () => {
      throw new ApiClientError('PRINTING_OFF', { status: 409 });
    });
    fireEvent.click(button() as HTMLElement);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(tr('error.printingOff'));
  });

  test('offline sends nothing and says so', async () => {
    const env = await open('cashier', async () => ({ job: job(1), replay: false }), true);
    fireEvent.click(button() as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(tr('print.reprint.offline')),
    );
    expect(env.api.print.reprint).not.toHaveBeenCalled();
  });
});
