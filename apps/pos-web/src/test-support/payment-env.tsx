/**
 * Shared set-up for the payment screen tests: one order of ฿75.00 in the store, a signed-in role,
 * a fake payments API, and the clock fixed at noon on a day inside the test co-pay scheme.
 * Everything is made up.
 */
import { catalogs } from '@sds/i18n';
import {
  type OrderDto,
  type PaymentDto,
  type RealtimeFrame,
  type StaffRole,
  satang,
} from '@sds/shared';
import { screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { orderDto, paymentDto, uuid } from './frames.ts';
import { createTestAuth, createTestServices, type TestPromptpay } from './render.tsx';

export const th = catalogs.th;
export const en = catalogs.en;

/** 12:00 in Bangkok on 15 Oct 2030, inside the test co-pay scheme (1 Oct - 30 Nov 2030). */
export const NOON = new Date('2030-10-15T05:00:00Z');
export const ORDER = uuid(900);
export const PAYMENT = uuid(500);
export const TOTAL = satang(7500);

/** Fixes the clock (only `Date`, so timers and promises keep working). Call in `beforeEach`. */
export function fixClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
}

export const orderOf = (over: Partial<OrderDto> = {}, rev = 10): OrderDto =>
  orderDto(ORDER, rev, { totalSatang: TOTAL, orderNo: 'S-013', ...over });

export const paymentOf = (over: Partial<PaymentDto> = {}, rev = 100): PaymentDto =>
  paymentDto(PAYMENT, ORDER, rev, { amountSatang: TOTAL, ...over });

/** What `api.payments.create` / `changeMethod` resolve with. */
export const created = (payment: PaymentDto, order: OrderDto) => ({
  result: { payment, order },
  replay: false,
  clientRequestId: uuid(1),
});

/** What a payment move (claim, confirm, void ...) resolves with. */
export const moved = (payment: PaymentDto, order: OrderDto) => ({ payment, order });

export interface SetupOptions {
  role?: StaffRole;
  order?: OrderDto;
  payments?: PaymentDto[];
  frames?: RealtimeFrame[];
  api?: Partial<ApiClient['payments']>;
  /** What the order calls answer (the receipt). */
  orders?: Partial<ApiClient['orders']>;
  /** The device starts offline (the outbox queues cash instead of sending it). */
  offline?: boolean;
  /** The PromptPay ID saved on the device (see `createTestServices`). */
  promptpay?: TestPromptpay;
}

export async function setup(options: SetupOptions = {}) {
  const { auth, stepUp } = await createTestAuth(options.role ?? 'cashier');
  const env = createTestServices({
    auth,
    ...(options.orders ? { orders: options.orders } : {}),
    ...(options.offline ? { offline: true } : {}),
    ...(options.promptpay ? { promptpay: options.promptpay } : {}),
    payments: {
      // The reload on opening the panel answers with what the store already has.
      list: async () => ({ payments: options.payments ?? [] }),
      ...(options.api ?? {}),
    },
  });
  const order = options.order ?? orderOf();
  env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
  for (const p of options.payments ?? []) {
    env.entities.apply({ type: 'payment.upserted', id: p.id, rev: p.rev, data: p });
  }
  for (const frame of options.frames ?? []) env.entities.apply(frame);
  return { ...env, stepUp };
}

export const methodTile = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });

/** Waits until the first load of the payments has finished. */
export const loaded = () =>
  waitFor(() => expect(screen.queryByText(th['payment.loading'])).toBeNull());
