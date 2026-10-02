// @vitest-environment jsdom
import { catalogs, translator } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, orderFrame, uuid } from '../test-support/frames.ts';
import { createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderDetailScreen } from './OrderDetailScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const ID = uuid(900);

afterEach(cleanup);

const withItems = (id = ID) =>
  orderDto(id, 40, {
    orderNo: 'S-007',
    fulfillment: 'room_delivery',
    roomNo: '1204',
    status: 'new',
    paymentStatus: 'unpaid',
    subtotalSatang: satang(6500),
    totalSatang: satang(6500),
    note: 'ไม่เอาถุง',
    items: [
      {
        id: uuid(1),
        menuItemId: uuid(2),
        nameTh: 'ก๋วยเตี๋ยวต้มยำ',
        nameEn: 'Tom yum noodles',
        unitPriceSatang: satang(5000),
        qty: 1,
        modifiers: [
          {
            groupId: uuid(3),
            optionId: uuid(4),
            nameTh: 'ไข่ต้ม',
            nameEn: 'Egg',
            priceDeltaSatang: satang(1000),
          },
        ],
        note: 'แยกน้ำ',
        lineTotalSatang: satang(6000),
      },
      {
        id: uuid(5),
        menuItemId: uuid(6),
        nameTh: 'ชาเย็น',
        nameEn: null,
        unitPriceSatang: satang(500),
        qty: 1,
        modifiers: [],
        note: null,
        lineTotalSatang: satang(500),
      },
    ],
  });

describe('the order page (a placeholder until the payment screens)', () => {
  test('shows the order from the store: the number, the status, the lines and the SERVER total', () => {
    const { services, entities } = createTestServices();
    entities.apply({ type: 'order.upserted', id: ID, rev: 40, data: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy();
    expect(screen.getByText(th['status.order.new'])).toBeTruthy();
    expect(screen.getByText(th['status.payment.unpaid'])).toBeTruthy();
    expect(screen.getByText(/ก๋วยเตี๋ยวต้มยำ/)).toBeTruthy();
    // The quantity sign comes from the catalog, not from the component.
    expect(screen.getAllByText(tr('order.detail.qty', { count: 1 })).length).toBe(2);
    expect(screen.getByText(/ไข่ต้ม/)).toBeTruthy();
    expect(screen.getByText(/แยกน้ำ/)).toBeTruthy();
    expect(screen.getByText(/ห้อง 1204/)).toBeTruthy();
    expect(screen.getByText(th['order.detail.serverTotal'])).toBeTruthy();
    expect(screen.getAllByText('฿65.00').length).toBeGreaterThan(0);
    expect(screen.getByText(th['order.detail.paymentSoon'])).toBeTruthy();
  });

  test('follows the store: a newer frame of the same order updates the page', () => {
    const { services, entities } = createTestServices();
    entities.apply({ type: 'order.upserted', id: ID, rev: 40, data: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    act(() => {
      entities.apply(
        orderFrame(ID, 41, { orderNo: 'S-007', status: 'preparing', paymentStatus: 'paid' }),
      );
    });
    expect(screen.getByText(th['status.order.preparing'])).toBeTruthy();
    expect(screen.getByText(th['status.payment.paid'])).toBeTruthy();
  });

  test('an order that is not in the store is fetched, and put into the store', async () => {
    const { services, entities, getOrder } = createTestServices({
      getOrder: async () => withItems(),
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByText(th['order.detail.loading'])).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy());
    expect(getOrder).toHaveBeenCalledWith(ID);
    expect(entities.getState().orders.has(ID)).toBe(true);
  });

  test('an order that does not exist says so, with a way back', async () => {
    const { services } = createTestServices({
      getOrder: async () => {
        throw new ApiClientError('NOT_FOUND', { status: 404 });
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(await screen.findByText(th['order.detail.notFound'])).toBeTruthy();
    expect(
      screen.getByRole('link', { name: th['order.detail.takeAnother'] }).getAttribute('href'),
    ).toBe('#/new');
  });

  test('a malformed id is not looked up: it is simply not found', () => {
    const { services, getOrder } = createTestServices();
    renderScreen(<OrderDetailScreen id="not-a-uuid" />, services);
    expect(screen.getByText(th['order.detail.notFound'])).toBeTruthy();
    expect(getOrder).not.toHaveBeenCalled();
  });

  test('a failed load shows our own message and can be retried', async () => {
    let calls = 0;
    const { services } = createTestServices({
      getOrder: async () => {
        calls += 1;
        if (calls === 1) throw new ApiClientError('NETWORK');
        return withItems();
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.network']);
    fireEvent.click(screen.getByRole('button', { name: th['common.retry'] }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy());
  });
});
