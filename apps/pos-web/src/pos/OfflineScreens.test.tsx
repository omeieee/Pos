// @vitest-environment jsdom
import { catalogs, formatDate } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createMemoryLocalStore, type OutboxEntry } from '../platform/localStore.ts';
import { IDS } from '../test-support/fixtures.ts';
import { govCopayFrame, orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { MENU, PLATFORM_DISH, seedPlatformDish } from '../test-support/menu-fixtures.ts';
import { fixClock, loaded, ORDER, orderOf, setup } from '../test-support/payment-env.tsx';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderDetailScreen } from './OrderDetailScreen.tsx';
import { OrderEntryScreen } from './OrderEntryScreen.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';
import { OutboxBadge } from './OutboxBadge.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

const th = catalogs.th;

beforeEach(() => {
  window.location.hash = '#/new';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = (element: HTMLElement) => fireEvent.click(element);
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

type Create = ApiClient['orders']['create'];
type Pay = ApiClient['payments']['create'];

const serverOrder = (orderNo = 'S-021') =>
  orderDto(uuid(900), 500, { orderNo, totalSatang: satang(2500), subtotalSatang: satang(2500) });

const okCreate: Create = async (_input, options) => ({
  order: serverOrder(),
  replay: false,
  clientRequestId: options?.clientRequestId ?? '',
});

async function offlineCounter(options: Parameters<typeof createTestServices>[0] = {}) {
  const { auth } = await createTestAuth();
  const made = createTestServices({ queue: true, offline: true, auth, ...options });
  made.cart.setBuilding('B1');
  made.cart.setRecipientName('Fah ตัวอย่าง');
  return made;
}

async function placeTeaOffline(made: Awaited<ReturnType<typeof offlineCounter>>) {
  renderScreen(<OrderEntryScreen />, made.services);
  await settle();
  click(tile('ชาเย็น'));
  click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
  await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
  await settle();
  return made.outbox.getState().items[0];
}

describe('order entry while offline', () => {
  test('says the order is saved on the device, and the same button saves it', async () => {
    const made = await offlineCounter();
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    click(tile('ชาเย็น'));
    expect(screen.getByText(th['pos.orderEntry.offlineHint'])).toBeTruthy();
    expect(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] })).toBeTruthy();
    expect(made.create).not.toHaveBeenCalled();
  });

  test('saving moves to the order page of the waiting order, with a temporary number', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    expect(made.create).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/orders/${item?.id}`);
    expect(item).toMatchObject({ kind: 'order', state: 'queued' });
    expect(made.cart.getState().lines).toHaveLength(0);
  });

  test('when the device cannot save it, says so and keeps the order on screen', async () => {
    const made = await offlineCounter({
      localStore: {
        persistent: false,
        kv: {
          get: async () => undefined,
          set: async () => undefined,
          remove: async () => undefined,
        },
        outbox: {
          put: async () => undefined,
          list: async () => [],
          remove: async () => undefined,
          count: async () => 0,
        },
      },
    });
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.error.storage'])).toBeTruthy());
    expect(made.cart.getState().lines).toHaveLength(1);
    expect(window.location.hash).toBe('#/new');
  });
});

describe('the order that is only on the device', () => {
  test('shows its label, the waiting badge, its lines and an estimate labelled as one', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(item?.label ?? 'x');
    expect(screen.getAllByText(th['outbox.state.waiting']).length).toBeGreaterThan(0);
    expect(screen.getByText('ชาเย็น')).toBeTruthy();
    expect(screen.getByText(th['outbox.order.estimateHint'])).toBeTruthy();
    expect(screen.getByText('B1 · Fah ตัวอย่าง')).toBeTruthy();
    // It never asked the server for an order that does not exist there yet.
    expect(made.getOrder).not.toHaveBeenCalled();
  });

  test('with no PromptPay ID saved on the device: cash only, PromptPay is off and says to connect once; ไทยช่วยไทย is not there', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByText(th['outbox.onlineOnly'])).toBeTruthy();
    const promptpay = screen.getByRole('radio', {
      name: new RegExp(th['payment.method.promptpay']),
    }) as HTMLInputElement;
    expect(promptpay.disabled).toBe(true);
    expect(screen.getByText(th['payment.copay.reason.qrNone'])).toBeTruthy();
    expect(
      screen.queryByRole('radio', { name: new RegExp(th['payment.method.gov_copay']) }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: th['payment.cash.exact'] })).toBeTruthy();
  });

  test('cash: the change is the usual calculation, the entry waits behind the order, nothing is shown as paid', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    expect(screen.getAllByText('฿75.00').length).toBeGreaterThan(0);
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.getByText('รับ ฿100.00 · ทอน ฿75.00')).toBeTruthy();
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
    const kinds = made.outbox.getState().items.map((i) => [i.kind, i.state]);
    expect(kinds).toEqual([
      ['order', 'queued'],
      ['payment', 'queued'],
    ]);
    expect(made.api.payments.create).not.toHaveBeenCalled();
  });

  test('the cash amount can be corrected before it is sent, and the cashier is told', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.queryByText(th['outbox.cash.changed'])).toBeNull();

    click(screen.getByRole('button', { name: th['outbox.cash.change'] }));
    const dialog = screen.getByRole('dialog');
    click(within(dialog).getByRole('button', { name: th['payment.cash.exact'] }));
    click(within(dialog).getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.changed'])).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/^รับ ฿25\.00/)).toBeTruthy();
    expect(made.outbox.getState().items.filter((i) => i.kind === 'payment')).toHaveLength(1);
  });

  test('once a send was tried the amount can no longer be corrected', async () => {
    const made = await offlineCounter({
      create: okCreate,
      payments: {
        create: (async () => {
          throw new ApiClientError('NETWORK');
        }) as Pay,
      },
    });
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.getByRole('button', { name: th['outbox.cash.change'] })).toBeTruthy();
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.api.payments.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: th['outbox.cash.change'] })).toBeNull(),
    );
  });

  test('when the connection returns the order and the cash sync once, and the page follows the real order', async () => {
    const calls: string[] = [];
    const made = await offlineCounter({
      create: async (input, options) => {
        calls.push('order');
        return okCreate(input, options);
      },
      payments: {
        create: (async (orderId, _input, options) => {
          calls.push('cash');
          return {
            result: {
              payment: paymentDto(uuid(500), orderId, 600, { amountSatang: satang(2500) }),
              order: serverOrder(),
            },
            replay: false,
            clientRequestId: options?.clientRequestId ?? '',
          };
        }) as Pay,
      },
    });
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());

    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(0));
    expect(calls).toEqual(['order', 'cash']);
    expect(made.entities.getState().orders.get(uuid(900))?.orderNo).toBe('S-021');
    expect(window.location.hash).toBe(`#/orders/${uuid(900)}`);
  });
});

describe('the orders list with orders waiting', () => {
  test('lists them with the waiting badge and the temporary number, above the board', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    const section = screen.getByRole('region', { name: new RegExp(th['outbox.section.title']) });
    expect(within(section).getByText(item?.label ?? 'x')).toBeTruthy();
    expect(within(section).getByText(th['outbox.state.waiting'])).toBeTruthy();
    expect(within(section).getByText('B1 · Fah ตัวอย่าง')).toBeTruthy();
    expect(screen.getByText(th['outbox.section.hint'])).toBeTruthy();
  });

  test('a refused entry shows the reason, with send again and remove (after a confirmation)', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', { status: 422 });
      },
    });
    const item = await placeTeaOffline(made);
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items[0]?.state).toBe('attention'));
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.getAllByText(th['outbox.state.attention']).length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain(th['error.orderInvalid']);
    expect(screen.getByRole('button', { name: th['outbox.retry'] })).toBeTruthy();

    click(screen.getByRole('button', { name: th['outbox.discard'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(th['outbox.discard.order'])).toBeTruthy();
    click(within(dialog).getByRole('button', { name: th['outbox.discard.keep'] }));
    expect(made.outbox.getState().items).toHaveLength(1);

    click(screen.getByRole('button', { name: th['outbox.discard'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.discard.confirm'],
      }),
    );
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(0));
    expect(item?.id).toBeTruthy();
  });

  test('a reused request id can only be removed, not sent again', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('IDEMPOTENCY_KEY_REUSED', { status: 409 });
      },
    });
    await placeTeaOffline(made);
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items[0]?.state).toBe('attention'));
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.queryByRole('button', { name: th['outbox.retry'] })).toBeNull();
    expect(screen.getByRole('button', { name: th['outbox.discard'] })).toBeTruthy();
  });

  test('shows only a count for entries of another person', async () => {
    const made = await offlineCounter();
    await placeTeaOffline(made);
    const row = (await made.localStore.outbox.list())[0];
    if (!row) throw new Error('no row');
    await made.localStore.outbox.put({ ...row, id: uuid(77), staffId: uuid(78) });
    // Reopen as the same person: the other row is counted, never shown.
    made.unbindOutbox();
    cleanup();
    const again = createTestServices({ queue: true, offline: true, localStore: made.localStore });
    renderScreen(<OrdersScreen />, again.services);
    await settle();
    expect(screen.getByText(th['outbox.others'].replace('{count}', '1'))).toBeTruthy();
    expect(again.outbox.getState().items).toHaveLength(1);
  });
});

describe('the saved menu notice', () => {
  const SAVED_AT = Date.UTC(2026, 9, 2, 3, 30);
  const text = () =>
    th['catalogue.offline'].replace('{time}', formatDate(SAVED_AT, 'th', 'dateTime'));

  test('shows, with the time it was saved, when the menu is the saved copy and the device is offline', async () => {
    const { auth } = await createTestAuth();
    const made = createTestServices({
      queue: true,
      offline: true,
      auth,
      catalogue: { fromCache: true, savedAt: SAVED_AT },
    });
    made.cart.setBuilding('B1');
    made.cart.setRecipientName('Fah ตัวอย่าง');
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    expect(screen.getByText(text())).toBeTruthy();
    // The menu itself works: a dish can be added and the order is queued.
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
  });

  test('is not there when online, nor when the menu is not from the saved copy', async () => {
    const { auth } = await createTestAuth();
    const online = createTestServices({
      auth,
      catalogue: { fromCache: true, savedAt: SAVED_AT },
    });
    renderScreen(<OrderEntryScreen />, online.services);
    await settle();
    expect(screen.queryByText(text())).toBeNull();
    cleanup();
    const live = createTestServices({ auth, offline: true, catalogue: { fromCache: false } });
    renderScreen(<OrderEntryScreen />, live.services);
    await settle();
    expect(screen.queryByText(text())).toBeNull();
  });
});

describe('the owner and the entries other people left on the device', () => {
  const strangerRows = (): OutboxEntry[] =>
    [uuid(71), uuid(72)].map((id, i) => ({
      id,
      kind: 'order.create',
      payload: {
        body: {
          channel: 'storefront',
          fulfillment: 'entrance_delivery',
          deliveryBuilding: 'B1',
          recipientName: 'ชื่อลูกค้าลับ',
          items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
        },
        label: `XZ-0${i + 1}`,
        lines: [
          { name: { th: 'ชาเย็น', en: null }, options: [], qty: 1, note: '', lineTotalSatang: 2500 },
        ],
        estimateSatang: 2500,
      },
      createdAt: Date.now() - (i + 1) * 1000,
      attempts: 0,
      state: 'queued' as const,
      staffId: uuid(78),
      deviceId: IDS.device,
    }));

  async function counterWithStrangers(
    role: 'owner' | 'cashier',
    options: Parameters<typeof createTestServices>[0] = {},
  ) {
    const { auth } = await createTestAuth(role);
    const localStore = { ...createMemoryLocalStore(), persistent: true };
    for (const row of strangerRows()) await localStore.outbox.put(row);
    const made = createTestServices({ queue: true, auth, localStore, ...options });
    renderScreen(<OrdersScreen />, made.services);
    await settle();
    return { made, auth, localStore };
  }

  test('a cashier sees only the count, with nothing to do about it', async () => {
    await counterWithStrangers('cashier');
    expect(screen.getByText(th['outbox.others'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['outbox.others.takeOver'] })).toBeNull();
    expect(screen.queryByRole('button', { name: th['outbox.others.clear'] })).toBeNull();
  });

  test('take over: a confirmation names the count and shows no personal data, the step-up comes first, then they are the owner’s', async () => {
    const { made, auth } = await counterWithStrangers('owner');
    const stepUp = vi.spyOn(auth, 'runSensitive');
    click(screen.getByRole('button', { name: th['outbox.others.takeOver'] }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(th['outbox.others.takeOver.title'].replace('{count}', '2')),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain('ชื่อลูกค้าลับ');
    expect(stepUp).not.toHaveBeenCalled();
    click(within(dialog).getByRole('button', { name: th['outbox.others.takeOver.confirm'] }));
    await waitFor(() => expect(stepUp).toHaveBeenCalledTimes(1));
    // The real step-up dialog is up (the owner's password factor); nothing changed yet.
    expect(made.outbox.getState().items).toHaveLength(0);
    expect(made.outbox.getState().othersCount).toBe(2);
  });

  test('once the step-up passes the entries are taken over and the result is told', async () => {
    const { made, auth } = await counterWithStrangers('owner');
    vi.spyOn(auth, 'runSensitive').mockImplementation(async (call) => ({
      ok: true as const,
      value: await call(),
    }));
    click(screen.getByRole('button', { name: th['outbox.others.takeOver'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.others.takeOver.confirm'],
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(th['outbox.others.done.takeOver'].replace('{count}', '2')),
      ).toBeTruthy(),
    );
    expect(made.outbox.getState().items).toHaveLength(2);
    expect(made.outbox.getState().othersCount).toBe(0);
    // The server heard about it first, with counts only.
    expect(made.api.devices.outboxRecovery).toHaveBeenCalledTimes(1);
    expect(made.api.devices.outboxRecovery.mock.calls[0]?.[1]).toEqual({
      action: 'take_over',
      orders: 2,
      payments: 0,
    });
  });

  test('offline it says so before asking for a password, and changes nothing', async () => {
    const { made, auth, localStore } = await counterWithStrangers('owner', { offline: true });
    const stepUp = vi.spyOn(auth, 'runSensitive');
    click(screen.getByRole('button', { name: th['outbox.others.takeOver'] }));
    expect(screen.getByText(th['outbox.others.offline'])).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    click(screen.getByRole('button', { name: th['outbox.others.clear'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stepUp).not.toHaveBeenCalled();
    expect(made.api.devices.outboxRecovery).not.toHaveBeenCalled();
    expect(await localStore.outbox.count()).toBe(2);
  });

  test('when the server refuses the report the reason is shown and the entries stay with their owners', async () => {
    const { made, auth, localStore } = await counterWithStrangers('owner', {
      devices: {
        outboxRecovery: async () => {
          throw new ApiClientError('IDEMPOTENCY_KEY_REUSED', { status: 409 });
        },
      },
    });
    vi.spyOn(auth, 'runSensitive').mockImplementation(async (call) => {
      try {
        return { ok: true as const, value: await call() };
      } catch (error) {
        return { ok: false as const, error: error as ApiClientError };
      }
    });
    click(screen.getByRole('button', { name: th['outbox.others.takeOver'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.others.takeOver.confirm'],
      }),
    );
    await waitFor(() => expect(screen.getByText(th['error.idempotencyKeyReused'])).toBeTruthy());
    expect(made.outbox.getState().othersCount).toBe(2);
    expect((await localStore.outbox.list()).every((row) => row.staffId === uuid(78))).toBe(true);
  });

  test('a server answer that is an error on the report itself is shown, not swallowed', async () => {
    const { auth } = await counterWithStrangers('owner', {
      devices: {
        outboxRecovery: async () => {
          throw new ApiClientError('NETWORK');
        },
      },
    });
    vi.spyOn(auth, 'runSensitive').mockImplementation(async (call) => ({
      ok: true as const,
      value: await call(),
    }));
    click(screen.getByRole('button', { name: th['outbox.others.clear'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.others.clear.confirm'],
      }),
    );
    await waitFor(() => expect(screen.getByText(th['error.network'])).toBeTruthy());
  });

  test('clear deletes them after the step-up; a cancelled step-up changes nothing', async () => {
    const { made, auth, localStore } = await counterWithStrangers('owner');
    const spy = vi.spyOn(auth, 'runSensitive').mockResolvedValueOnce({ ok: false, error: null });
    click(screen.getByRole('button', { name: th['outbox.others.clear'] }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(th['outbox.others.clear.title'].replace('{count}', '2')),
    ).toBeTruthy();
    click(within(dialog).getByRole('button', { name: th['outbox.others.clear.confirm'] }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Not silent: it says the owner has to sign in, online.
    expect(screen.getByText(th['error.ownerSignInNeeded'])).toBeTruthy();
    expect(await localStore.outbox.count()).toBe(2);

    spy.mockImplementation(async (call) => ({ ok: true as const, value: await call() }));
    click(screen.getByRole('button', { name: th['outbox.others.clear'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.others.clear.confirm'],
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(th['outbox.others.done.clear'].replace('{count}', '2'))).toBeTruthy(),
    );
    expect(await localStore.outbox.count()).toBe(0);
    expect(made.outbox.getState().othersCount).toBe(0);
  });
});

describe('an entry the owner took over, waiting for the owner’s step-up', () => {
  const taken = (): OutboxEntry => ({
    id: uuid(81),
    kind: 'order.create',
    payload: {
      body: {
        channel: 'storefront',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah ตัวอย่าง',
        items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
      },
      label: 'XZ-01',
      lines: [
        { name: { th: 'ชาเย็น', en: null }, options: [], qty: 1, note: '', lineTotalSatang: 2500 },
      ],
      estimateSatang: 2500,
    },
    createdAt: Date.now() - 1000,
    attempts: 0,
    state: 'queued',
    staffId: IDS.owner,
    deviceId: IDS.device,
    originalStaffId: uuid(78),
  });

  test('says so, keeps the entry, and the button asks for the step-up again', async () => {
    const { auth } = await createTestAuth('owner');
    const localStore = { ...createMemoryLocalStore(), persistent: true };
    await localStore.outbox.put(taken());
    const made = createTestServices({
      queue: true,
      auth,
      localStore,
      create: async () => {
        throw new ApiClientError('STEP_UP_REQUIRED', { status: 403 });
      },
    });
    renderScreen(<OrdersScreen />, made.services);
    await settle();
    // The step-up dialog came up by itself; the owner closes it.
    await waitFor(() => expect(auth.getState().stepUpOpen).toBe(true));
    act(() => auth.cancelStepUp());
    await waitFor(() => expect(screen.getByText(th['outbox.stepUp.waiting'])).toBeTruthy());
    expect(made.outbox.getState().items[0]).toMatchObject({ state: 'queued' });
    expect(await localStore.outbox.count()).toBe(1);

    click(screen.getByRole('button', { name: th['outbox.stepUp.ask'] }));
    await waitFor(() => expect(auth.getState().stepUpOpen).toBe(true));
    expect(await localStore.outbox.count()).toBe(1);
  });
});

describe('entries that need a person', () => {
  test('a stuck entry offers send now and remove, and the confirmation warns it may be on the server', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('INTERNAL', { status: 500 });
      },
    });
    await placeTeaOffline(made);
    act(() => made.life.goOnline());
    for (let i = 0; i < 7; i += 1) {
      act(() => made.outbox.kick());
      await settle();
    }
    expect(made.outbox.getState().items[0]).toMatchObject({ state: 'queued', stuck: true });
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.getByRole('button', { name: th['outbox.sendNow'] })).toBeTruthy();
    click(screen.getByRole('button', { name: th['outbox.discard'] }));
    expect(within(screen.getByRole('dialog')).getByText(th['outbox.discard.stuck'])).toBeTruthy();
  });

  test('cash refused as below the real total says to remove it and take the cash again online, with no send again', async () => {
    const made = await offlineCounter({
      create: okCreate,
      payments: {
        create: (async () => {
          throw new ApiClientError('TENDERED_BELOW_TOTAL', { status: 422 });
        }) as Pay,
      },
    });
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: th['payment.cash.exact'] }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items[0]?.state).toBe('attention'));
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.getByRole('alert').textContent).toBe(th['outbox.error.tenderBelow']);
    expect(screen.queryByRole('button', { name: th['outbox.retry'] })).toBeNull();
    expect(screen.getByRole('button', { name: th['outbox.discard'] })).toBeTruthy();
  });
});

describe('entries that wait for days', () => {
  const DAY = 86_400_000;

  async function reopenWith(change: (row: OutboxEntry) => OutboxEntry[]) {
    const made = await offlineCounter();
    await placeTeaOffline(made);
    const row = (await made.localStore.outbox.list())[0];
    if (!row) throw new Error('no row');
    for (const next of change(row)) await made.localStore.outbox.put(next);
    made.unbindOutbox();
    cleanup();
    const again = createTestServices({ queue: true, offline: true, localStore: made.localStore });
    renderScreen(<OrdersScreen />, again.services);
    await settle();
    return again;
  }

  test('my own entry older than 3 days is flagged "old, check" and kept', async () => {
    const again = await reopenWith((row) => [{ ...row, createdAt: Date.now() - 4 * DAY }]);
    expect(screen.getByText(th['outbox.state.old'])).toBeTruthy();
    expect(again.outbox.getState().items).toHaveLength(1);
  });

  test('a young entry is not flagged', async () => {
    await reopenWith((row) => [{ ...row, createdAt: Date.now() - 1 * DAY }]);
    expect(screen.queryByText(th['outbox.state.old'])).toBeNull();
  });

  test('entries of other people older than 14 days are purged, and only a count is shown', async () => {
    const again = await reopenWith((row) => [
      row,
      { ...row, id: uuid(77), staffId: uuid(78), createdAt: Date.now() - 20 * DAY },
    ]);
    expect(screen.getByText(th['outbox.purged'].replace('{count}', '1'))).toBeTruthy();
    expect(await again.localStore.outbox.count()).toBe(1);
  });
});

describe('the top bar badge', () => {
  test('shows nothing when nothing waits, then how many wait and how many need attention', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', { status: 422 });
      },
    });
    renderScreen(<OutboxBadge />, made.services);
    expect(screen.queryByRole('link')).toBeNull();
    await placeTeaOffline(made);
    expect(screen.getByText(th['outbox.badge.waiting'].replace('{count}', '1'))).toBeTruthy();
    act(() => made.life.goOnline());
    await waitFor(() =>
      expect(screen.getByText(th['outbox.badge.attention'].replace('{count}', '1'))).toBeTruthy(),
    );
    expect(screen.queryByText(th['outbox.badge.waiting'].replace('{count}', '1'))).toBeNull();
  });
});

describe('paying an order the server has, while offline', () => {
  test('cash stays; ไทยช่วยไทย needs the internet, and PromptPay is off until an ID is saved on the device', async () => {
    // Noon on a day inside the test scheme: co-pay would be on offer if the device were online.
    fixClock();
    const env = await setup({ offline: true, frames: [govCopayFrame(6)] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    const promptpay = screen.getByRole('radio', {
      name: new RegExp(th['payment.method.promptpay']),
    }) as HTMLInputElement;
    const copay = screen.getByRole('radio', {
      name: new RegExp(th['payment.method.gov_copay']),
    }) as HTMLInputElement;
    expect(promptpay.disabled).toBe(true);
    expect(copay.disabled).toBe(true);
    expect(screen.getAllByText(th['payment.copay.reason.needsInternet']).length).toBe(1);
    expect(screen.getByText(th['payment.copay.reason.qrNone'])).toBeTruthy();
    expect(screen.getByText(th['outbox.onlineOnly'])).toBeTruthy();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.cash']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
  });

  test('cash is queued against the SERVER order and its total, not sent', async () => {
    const env = await setup({ offline: true });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(env.api.payments.create).not.toHaveBeenCalled();
    expect(env.outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      orderId: ORDER,
      tenderedSatang: 10000,
      totalSatang: 7500,
    });
    expect(screen.getByText('รับ ฿100.00 · ทอน ฿25.00')).toBeTruthy();
    // The other methods are gone while cash waits, so nothing can collide with it.
    expect(
      screen.queryByRole('radio', { name: new RegExp(th['payment.method.promptpay']) }),
    ).toBeNull();
  });

  test('online, nothing changes: the usual call goes to the server', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.promptpay']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText(th['outbox.onlineOnly'])).toBeNull();
  });
});

describe('a Grab / LINE MAN order', () => {
  async function platformServices(options: Parameters<typeof createTestServices>[0] = {}) {
    const { auth } = await createTestAuth();
    const made = createTestServices({ queue: true, auth, ...options });
    seedPlatformDish(made.entities);
    return made;
  }

  test('shows the platform prices, and changing the platform changes them', async () => {
    const made = await platformServices();
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    expect(tile('ชามะนาว').textContent).toContain('฿30');
    click(screen.getByRole('radio', { name: 'LINE MAN' }));
    expect(tile('ชามะนาว').textContent).toContain('฿32');
    // A dish not sold on the platform is not on its menu.
    expect(screen.queryByRole('button', { name: /^ชาเย็น/ })).toBeNull();
  });

  test('has no recipient fields, and needs the platform order code before it can be created', async () => {
    const made = await platformServices();
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    click(tile('ชามะนาว'));
    expect(screen.queryByText(th['pos.delivery.building'])).toBeNull();
    const create = screen.getByRole('button', { name: th['platform.place'] }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText(th['platform.refNeeded'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-1234' } });
    expect(create.disabled).toBe(false);
  });

  test('is sent on the platform channel and opens the real order', async () => {
    const made = await platformServices({
      create: async (_input, options) => ({
        order: orderDto(uuid(901), 501, { orderNo: 'G-001', channel: 'grab' }),
        replay: false,
        clientRequestId: options?.clientRequestId ?? '',
      }),
    });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    click(tile('ชามะนาว'));
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-1234' } });
    click(screen.getByRole('button', { name: th['platform.place'] }));
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(901)}`));
    expect(made.create.mock.calls[0]?.[0]).toMatchObject({
      channel: 'grab',
      fulfillment: 'platform_delivery',
      note: 'GRAB GF-1234',
      items: [{ menuItemId: PLATFORM_DISH, qty: 1 }],
    });
  });

  test('keyed in while offline it is queued too, as a platform order with no cash offered', async () => {
    const made = await platformServices({ offline: true });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    await settle();
    click(tile('ชามะนาว'));
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-9' } });
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
    const item = made.outbox.getState().items[0];
    expect(item).toMatchObject({ kind: 'order', channel: 'grab', recipient: null });
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByText(th['platform.payment.hint'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.cash.exact'] })).toBeNull();
  });

  test('warns when the same platform code was already keyed in', async () => {
    const made = await platformServices();
    made.entities.apply({
      type: 'order.upserted',
      id: uuid(950),
      rev: 600,
      data: orderDto(uuid(950), 600, { channel: 'grab', note: 'GRAB GF-1234' }),
    });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'gf-1234' } });
    expect(screen.getByText(th['platform.duplicate'])).toBeTruthy();
  });

  test('its payment is the platform one, and co-pay is not offered', async () => {
    const env = await setup({
      order: orderOf({ channel: 'grab', fulfillment: 'platform_delivery' }),
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(
      screen.getByRole('radio', { name: new RegExp(th['payment.method.platform']) }),
    ).toBeTruthy();
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.gov_copay']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: th['payment.start.platform'] })).toBeTruthy();
  });
});

describe('the menu of the counter is untouched by the platform cart', () => {
  test('a dish added on the platform screen is not in the counter order', () => {
    const made = createTestServices({ queue: true });
    seedPlatformDish(made.entities);
    made.platformCart.addItem({ itemId: PLATFORM_DISH });
    expect(made.cart.getState().lines).toHaveLength(0);
    expect(MENU.tea).toBeTruthy();
  });
});
