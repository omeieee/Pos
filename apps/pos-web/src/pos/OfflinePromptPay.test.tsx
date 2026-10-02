// @vitest-environment jsdom
import { catalogs, formatDate, type MessageKey } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { IDS } from '../test-support/fixtures.ts';
import {
  orderDto,
  paymentDto,
  paymentMethodsFrame,
  settingsFrame,
  uuid,
} from '../test-support/frames.ts';
import { fixClock, loaded, methodTile, ORDER, setup } from '../test-support/payment-env.tsx';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OfflinePromptPay } from './OfflinePromptPay.tsx';
import { OrderDetailScreen } from './OrderDetailScreen.tsx';
import { OrderEntryScreen } from './OrderEntryScreen.tsx';
import {
  OFFLINE_QR_MAX_AGE_MS,
  PROMPTPAY_CACHE_SCHEMA,
  type SavedPromptpay,
} from './offline-promptpay-model.ts';
import { PaymentPanel } from './PaymentPanel.tsx';

const th = catalogs.th;
/** A made-up number in the right shape: never a real account. */
const ID = '0812345678';

beforeEach(() => {
  window.location.hash = '#/new';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = (element: HTMLElement) => fireEvent.click(element);
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

const record = (over: Partial<SavedPromptpay> = {}): SavedPromptpay => ({
  v: PROMPTPAY_CACHE_SCHEMA,
  staffId: IDS.cashier,
  savedAt: Date.now() - 5 * 60_000,
  rev: 5,
  stale: false,
  target: { idType: 'phone', idValue: ID },
  ...over,
});

const bannerFor = (saved: SavedPromptpay) =>
  th['payment.offlineQr.banner']
    .replace('{last4}', '5678')
    .replace('{time}', formatDate(saved.savedAt, 'th', 'time'));

/** Nothing of the account number, in any text or attribute of the page. */
const pageHoldsNoId = () => {
  expect(document.body.innerHTML).not.toContain(ID);
  expect(document.body.innerHTML).not.toContain('000201');
  expect(document.body.innerHTML).not.toContain('A000000677010111');
};

describe('an order the server has, paid by PromptPay while the device is offline', () => {
  test('shows the offline banner (account tail, saved time), the SERVER total, and a QR that holds no ID in the page', async () => {
    fixClock();
    const saved = record({ savedAt: Date.now() - 5 * 60_000 });
    const env = await setup({ offline: true, promptpay: { record: saved } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    expect((methodTile(th['payment.method.promptpay']) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(th['outbox.onlineOnlyCopay'])).toBeTruthy();
    click(methodTile(th['payment.method.promptpay']));

    expect(screen.getByText(bannerFor(saved))).toBeTruthy();
    expect(screen.getByText(th['payment.offlineQr.amount.server'])).toBeTruthy();
    expect(
      await screen.findByRole('img', {
        name: th['payment.offlineQr.alt'].replace('{amount}', '฿75.00'),
      }),
    ).toBeTruthy();
    // The estimate warning belongs to a local order, not to a total the server gave.
    expect(screen.queryByText(th['payment.offlineQr.estimateWarning'])).toBeNull();
    pageHoldsNoId();
    expect(env.api.payments.qrUrl).not.toHaveBeenCalled();
  });

  test('"the customer paid" is a staff tap: it saves the payment behind its order, shows it as waiting (never paid), and sends nothing', async () => {
    fixClock();
    const env = await setup({ offline: true, promptpay: { record: record() } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img');
    // Nothing is saved by showing the QR.
    expect(env.outbox.getState().items).toHaveLength(0);

    click(screen.getByRole('button', { name: th['payment.offlineQr.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.promptpay.waiting'])).toBeTruthy());
    expect(env.outbox.getState().items).toHaveLength(1);
    expect(env.outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      method: 'promptpay',
      orderId: ORDER,
      qrAmountSatang: 7500,
      amountKind: 'server',
      state: 'queued',
    });
    expect(screen.getByText(th['outbox.state.waiting'])).toBeTruthy();
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
    expect(env.api.payments.create).not.toHaveBeenCalled();
    // The saved entries hold the amount and the masked account, never the ID or the payload.
    const stored = JSON.stringify(await env.localStore.outbox.list());
    expect(stored).toContain('******5678');
    expect(stored).not.toContain(ID);
    expect(stored).not.toContain('000201');
  });

  test('a second tap while it is saving saves one payment', async () => {
    fixClock();
    const env = await setup({ offline: true, promptpay: { record: record() } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img');
    const button = screen.getByRole('button', { name: th['payment.offlineQr.confirm'] });
    click(button);
    click(button);
    await waitFor(() => expect(screen.getByText(th['outbox.promptpay.waiting'])).toBeTruthy());
    expect(await env.localStore.outbox.count()).toBe(2);
  });

  const unusable: [string, () => SavedPromptpay | undefined, MessageKey][] = [
    ['no ID saved', () => undefined, 'payment.copay.reason.qrNone'],
    [
      'a change notice not yet confirmed',
      () => record({ stale: true }),
      'payment.copay.reason.qrStale',
    ],
    [
      'an ID older than 24 hours',
      () => record({ savedAt: Date.now() - OFFLINE_QR_MAX_AGE_MS - 60_000 }),
      'payment.copay.reason.qrTooOld',
    ],
  ];
  test.each(unusable)(
    'with %s: PromptPay is off, says why, and no QR can be shown',
    async (_name, make, key) => {
      fixClock();
      const saved = make();
      const env = await setup({
        offline: true,
        ...(saved === undefined ? {} : { promptpay: { record: saved } }),
      });
      renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
      await loaded();
      await settle();
      expect((methodTile(th['payment.method.promptpay']) as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText(th[key])).toBeTruthy();
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByText(th['outbox.onlineOnly'])).toBeTruthy();
    },
  );

  test('the saved ID ages past 24 hours while the QR is on screen: the QR goes away and the reason shows', async () => {
    fixClock();
    const env = await setup({ offline: true, promptpay: { record: record() } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img');
    act(() => {
      vi.setSystemTime(Date.now() + OFFLINE_QR_MAX_AGE_MS + 120_000);
      // The screen re-reads the clock whenever it re-renders (here: another row arrives).
      env.entities.apply(paymentMethodsFrame(99));
    });
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    expect(screen.getByText(th['payment.copay.reason.qrTooOld'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.offlineQr.confirm'] })).toBeNull();
  });

  test('a change notice while the QR is on screen takes it away at once', async () => {
    fixClock();
    const env = await setup({ offline: true, promptpay: { record: record({ rev: 5 }) } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img');
    act(() => env.entities.apply(settingsFrame('promptpay', 50, 2)));
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    expect(screen.getByText(th['payment.copay.reason.qrStale'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.offlineQr.confirm'] })).toBeNull();
  });

  test('co-pay stays off the internet-only list even with a good saved ID', async () => {
    fixClock();
    const env = await setup({ offline: true, promptpay: { record: record() } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    await settle();
    expect((methodTile(th['payment.method.gov_copay']) as HTMLInputElement).disabled).toBe(true);
  });

  test('online, nothing changes: PromptPay asks the server (no offline banner)', async () => {
    fixClock();
    const env = await setup({ promptpay: { record: record() } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    click(methodTile(th['payment.method.promptpay']));
    expect(screen.queryByText(th['payment.offlineQr.title'])).toBeNull();
    expect(screen.queryByText(th['payment.offlineQr.banner'])).toBeNull();
  });
});

describe('the QR panel on its own', () => {
  test('a zero amount shows no QR and says so', async () => {
    const { auth } = await createTestAuth();
    const made = createTestServices({ auth, offline: true, promptpay: { record: record() } });
    renderScreen(
      <OfflinePromptPay
        amountSatang={0}
        amountKind="estimate"
        submit={async () => ({ ok: true, id: 'x', label: 'X' })}
      />,
      made.services,
    );
    await settle();
    expect(screen.getByText(th['payment.offlineQr.refused.badAmount'])).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('English words are there too', async () => {
    const { auth } = await createTestAuth();
    const made = createTestServices({ auth, offline: true });
    renderScreen(
      <OfflinePromptPay
        amountSatang={7500}
        amountKind="estimate"
        submit={async () => ({ ok: true, id: 'x', label: 'X' })}
      />,
      made.services,
      'en',
    );
    await settle();
    expect(screen.getByText(catalogs.en['payment.offlineQr.refused.none'])).toBeTruthy();
  });
});

describe('an order that is only on the device', () => {
  const serverOrder = () =>
    orderDto(uuid(900), 500, {
      orderNo: 'S-021',
      totalSatang: satang(2500),
      subtotalSatang: satang(2500),
    });
  type Create = ApiClient['orders']['create'];
  type Pay = ApiClient['payments']['create'];
  type Confirm = ApiClient['payments']['confirm'];

  async function offlineCounter(options: Parameters<typeof createTestServices>[0] = {}) {
    const { auth } = await createTestAuth();
    const made = createTestServices({
      queue: true,
      offline: true,
      auth,
      promptpay: { record: record() },
      ...options,
    });
    made.cart.setBuilding('B1');
    made.cart.setRecipientName('Fah ตัวอย่าง');
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
    await settle();
    cleanup();
    const item = made.outbox.getState().items[0];
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    return { made, item };
  }

  test('offers PromptPay with an ESTIMATE QR, labelled as one, and no ID in the page', async () => {
    const { made } = await offlineCounter();
    expect((methodTile(th['payment.method.promptpay']) as HTMLInputElement).disabled).toBe(false);
    click(methodTile(th['payment.method.promptpay']));
    expect(screen.getByText(th['payment.offlineQr.amount.estimate'])).toBeTruthy();
    expect(screen.getByText(th['payment.offlineQr.estimateWarning'])).toBeTruthy();
    expect(
      await screen.findByRole('img', {
        name: th['payment.offlineQr.alt'].replace('{amount}', '฿25.00'),
      }),
    ).toBeTruthy();
    pageHoldsNoId();
    expect(made.api.payments.create).not.toHaveBeenCalled();
  });

  test('staff confirm: it waits behind the order; when the connection returns the order, the payment and its confirm go once each, in that order', async () => {
    const calls: string[] = [];
    const create: Create = async (_input, options) => {
      calls.push('order');
      return {
        order: serverOrder(),
        replay: false,
        clientRequestId: options?.clientRequestId ?? '',
      };
    };
    const pay: Pay = async (orderId, input, options) => {
      calls.push(`create:${input.method}`);
      return {
        result: {
          payment: paymentDto(uuid(500), orderId, 600, {
            method: 'promptpay',
            status: 'pending',
            amountSatang: satang(2500),
            promptpayTargetMasked: '******5678',
          }),
          order: serverOrder(),
        },
        replay: false,
        clientRequestId: options?.clientRequestId ?? '',
      };
    };
    const confirm: Confirm = async (paymentId) => {
      calls.push('confirm');
      return {
        payment: paymentDto(paymentId, uuid(900), 700, {
          method: 'promptpay',
          status: 'confirmed',
          amountSatang: satang(2500),
        }),
        order: serverOrder(),
      };
    };
    const { made, item } = await offlineCounter({ create, payments: { create: pay, confirm } });
    click(methodTile(th['payment.method.promptpay']));
    await screen.findByRole('img');
    click(screen.getByRole('button', { name: th['payment.offlineQr.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.promptpay.waiting'])).toBeTruthy());
    expect(made.outbox.getState().items.map((i) => i.kind)).toEqual(['order', 'payment']);
    expect(made.outbox.getState().items[1]).toMatchObject({
      method: 'promptpay',
      dependsOn: item?.id,
      amountKind: 'estimate',
    });
    expect(calls).toEqual([]);

    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(0));
    expect(calls).toEqual(['order', 'create:promptpay', 'confirm']);
    expect(made.entities.getState().payments.get(uuid(500))?.status).toBe('confirmed');
  });

  test('with no usable ID the tile is off and cash still works', async () => {
    await offlineCounter({ promptpay: { record: record({ stale: true }) } });
    expect((methodTile(th['payment.method.promptpay']) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.qrStale'])).toBeTruthy();
    expect(screen.getByRole('button', { name: th['payment.cash.exact'] })).toBeTruthy();
  });
});
