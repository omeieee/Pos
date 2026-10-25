// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  itemFrame,
  orderFrame,
  paymentAlertFrame,
  paymentFrame,
  uuid,
} from '../../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { PaymentArrivedPopup } from './PaymentArrivedPopup.tsx';
import { PaymentPopupSwitch } from './PaymentPopupSwitch.tsx';

const tr = translator('th');
afterEach(cleanup);

const DISH = uuid(300);

const lineOrder = (n: number, over: Parameters<typeof orderFrame>[2] = {}) =>
  orderFrame(uuid(n), n, {
    orderNo: `L-00${n}`,
    channel: 'line',
    recipientName: 'พิม',
    deliveryBuilding: 'D1',
    roomNo: '1204',
    note: 'ไม่เผ็ด',
    totalSatang: satang(6200),
    line: { displayName: 'Pim LINE', pictureUrl: null },
    items: [
      {
        id: uuid(400 + n),
        menuItemId: DISH,
        nameTh: 'ก๋วยเตี๋ยวต้มยำ',
        nameEn: 'Tom yum noodles',
        unitPriceSatang: satang(3100),
        qty: 2,
        modifiers: [],
        note: null,
        lineTotalSatang: satang(6200),
      },
    ],
    ...over,
  });

async function setup(role: 'cashier' | 'kitchen' = 'cashier') {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({ auth });
  env.entities.applyMany([itemFrame(DISH, 3, { photoVersion: 2 }), lineOrder(1), lineOrder(2)]);
  renderScreen(<PaymentArrivedPopup />, env.services);
  return env;
}

const live = (
  env: Awaited<ReturnType<typeof setup>>,
  ...frames: Parameters<typeof env.entities.apply>[0][]
) =>
  act(() => {
    for (const frame of frames) env.entities.apply(frame);
  });

describe('the payment pop-up', () => {
  test('shows nothing until a live payment alert arrives', async () => {
    await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a paid alert shows the LINE name, the web name, the building, the dishes and the total', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(1), 'paid', 'L-001'));
    const dialog = await screen.findByRole('dialog', { name: tr('payPopup.title.paid') });
    const text = dialog.textContent ?? '';
    expect(text).toContain('L-001');
    expect(text).toContain('Pim LINE');
    expect(text).toContain('พิม');
    expect(text).toContain(tr('payPopup.building', { building: 'D1' }));
    expect(text).toContain('ก๋วยเตี๋ยวต้มยำ');
    expect(text).toContain('2×');
    expect(text).toContain('62');
    // The dish photo comes from the menu's photo path.
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain(
      `/v1/menu/items/${DISH}/photo?v=2`,
    );
  });

  test('never shows the room or the note', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(1)));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain('1204');
    expect(dialog.textContent).not.toContain('ไม่เผ็ด');
  });

  test('the paid variant has OK and "view order"; OK closes it', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(1)));
    const dialog = await screen.findByRole('dialog');
    const view = within(dialog).getByRole('link', { name: tr('payPopup.viewOrder') });
    expect(view.getAttribute('href')).toBe(`#/orders/${uuid(1)}`);
    fireEvent.click(within(dialog).getByRole('button', { name: tr('payPopup.ok') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the slip-review variant is amber with a "check the slip" link to the order', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(2), 'slip_review', 'L-002'));
    const dialog = await screen.findByRole('dialog', { name: tr('payPopup.title.slip_review') });
    expect(dialog.querySelector('.ppop--slip_review')).not.toBeNull();
    const link = within(dialog).getByRole('link', { name: tr('payPopup.checkSlip') });
    expect(link.getAttribute('href')).toBe(`#/orders/${uuid(2)}`);
  });

  test('several stack: the second shows after the first is closed, and the first says one is waiting', async () => {
    const env = await setup();
    live(
      env,
      paymentAlertFrame(uuid(90), uuid(1), 'paid', 'L-001'),
      paymentAlertFrame(uuid(91), uuid(2), 'slip_review', 'L-002'),
    );
    const first = await screen.findByRole('dialog', { name: tr('payPopup.title.paid') });
    expect(first.textContent).toContain(tr('payPopup.more', { count: 1 }));
    fireEvent.click(within(first).getByRole('button', { name: tr('payPopup.ok') }));
    const second = await screen.findByRole('dialog', { name: tr('payPopup.title.slip_review') });
    expect(second.textContent).toContain('L-002');
  });

  test('Escape closes it, like the OK button', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(1)));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('when the switch is off nothing shows, and turning it on again brings it back', async () => {
    const env = await setup();
    await act(() => env.paymentPopup.setEnabled(false));
    live(env, paymentAlertFrame(uuid(90), uuid(1)));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(() => env.paymentPopup.setEnabled(true));
    live(env, paymentAlertFrame(uuid(91), uuid(1)));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  test('the kitchen sees no total and no way to confirm a slip', async () => {
    const env = await setup('kitchen');
    live(env, paymentAlertFrame(uuid(90), uuid(2), 'slip_review', 'L-002'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(tr('payPopup.total'))).toBeNull();
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).getByRole('button', { name: tr('payPopup.ok') })).toBeTruthy();
  });

  test('an order that has not reached the store yet shows its number and a loading line', async () => {
    const env = await setup();
    live(env, paymentAlertFrame(uuid(90), uuid(77), 'paid', 'L-077'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('L-077');
    expect(dialog.textContent).toContain(tr('payPopup.noOrder'));
  });

  test('a payment frame for the order does not open a pop-up by itself', async () => {
    const env = await setup();
    live(env, paymentFrame(uuid(500), uuid(1), 9, { method: 'promptpay', status: 'confirmed' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the per-device switch', () => {
  test('is a real switch, on by default, remembered when changed', async () => {
    const { auth } = await createTestAuth('cashier');
    const env = createTestServices({ auth });
    renderScreen(<PaymentPopupSwitch />, env.services);
    const toggle = screen.getByRole('switch', { name: tr('payPopup.switchShort') });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(env.popupPrefs.value()).toBe(false));
  });
});
