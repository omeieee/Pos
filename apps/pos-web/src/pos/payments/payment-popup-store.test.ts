import { describe, expect, test, vi } from 'vitest';
import { createEntityStore } from '../../realtime/entity-store.ts';
import { alertFrame, orderFrame, paymentAlertFrame, uuid } from '../../test-support/frames.ts';
import { createPaymentPopupStore } from './payment-popup-store.ts';

function setup(saved?: boolean) {
  const entities = createEntityStore();
  const prefs = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (_enabled: boolean) => undefined),
  };
  const popup = createPaymentPopupStore({ entities, prefs });
  const unbind = popup.bind();
  return { entities, prefs, popup, unbind };
}

describe('the payment pop-up store', () => {
  test('is on by default, before and after reading a saved choice that is not "off"', async () => {
    const { popup } = setup(undefined);
    expect(popup.getState().enabled).toBe(true);
    await popup.init();
    expect(popup.getState()).toMatchObject({ enabled: true, loaded: true });
  });

  test('reads a remembered "off" and saves a change', async () => {
    const { popup, prefs } = setup(false);
    await popup.init();
    expect(popup.getState().enabled).toBe(false);
    await popup.setEnabled(true);
    expect(popup.getState().enabled).toBe(true);
    expect(prefs.save).toHaveBeenCalledWith(true);
  });

  test('a live alert.payment frame queues a pop-up; the new-order alert and rows do not', () => {
    const { entities, popup } = setup();
    entities.apply(alertFrame(uuid(1)));
    entities.apply(orderFrame(uuid(2), 5));
    expect(popup.getState().queue).toEqual([]);
    entities.apply(paymentAlertFrame(uuid(3), uuid(10), 'paid', 'L-010'));
    expect(popup.getState().queue).toEqual([{ orderId: uuid(10), orderNo: 'L-010', kind: 'paid' }]);
  });

  test('several stack in order; dismissing shows the next', () => {
    const { entities, popup } = setup();
    entities.apply(paymentAlertFrame(uuid(1), uuid(10), 'paid', 'L-010'));
    entities.apply(paymentAlertFrame(uuid(2), uuid(11), 'slip_review', 'L-011'));
    expect(popup.getState().queue.map((e) => e.orderNo)).toEqual(['L-010', 'L-011']);
    popup.dismiss();
    expect(popup.getState().queue.map((e) => e.orderNo)).toEqual(['L-011']);
    popup.dismiss();
    popup.dismiss();
    expect(popup.getState().queue).toEqual([]);
  });

  test('the same frame twice, or the same order and kind again, is one pop-up', () => {
    const { entities, popup } = setup();
    entities.apply(paymentAlertFrame(uuid(1), uuid(10)));
    entities.apply(paymentAlertFrame(uuid(1), uuid(10)));
    entities.apply(paymentAlertFrame(uuid(2), uuid(10)));
    expect(popup.getState().queue).toHaveLength(1);
  });

  test('a paid alert after a slip_review alert of the same order is not dropped', () => {
    const { entities, popup } = setup();
    entities.apply(paymentAlertFrame(uuid(10), uuid(10), 'slip_review'));
    popup.dismiss();
    entities.apply(paymentAlertFrame(uuid(10), uuid(10), 'paid'));
    expect(popup.getState().queue.map((e) => e.kind)).toEqual(['paid']);
    entities.apply(paymentAlertFrame(uuid(10), uuid(10), 'paid'));
    expect(popup.getState().queue).toHaveLength(1);
  });

  test('nothing is queued while off, and turning off empties what waits', async () => {
    const { entities, popup } = setup();
    entities.apply(paymentAlertFrame(uuid(1), uuid(10)));
    await popup.setEnabled(false);
    expect(popup.getState().queue).toEqual([]);
    entities.apply(paymentAlertFrame(uuid(2), uuid(11)));
    expect(popup.getState().queue).toEqual([]);
    await popup.setEnabled(true);
    entities.apply(paymentAlertFrame(uuid(3), uuid(12)));
    expect(popup.getState().queue).toHaveLength(1);
  });

  test('a tap before the saved choice was read wins over it', async () => {
    const { popup } = setup(false);
    await popup.setEnabled(true);
    await popup.init();
    expect(popup.getState().enabled).toBe(true);
  });

  test('hydrate and catch-up carry no alerts, so a restart shows nothing', () => {
    const { entities, popup } = setup();
    entities.hydrate([orderFrame(uuid(2), 5)]);
    entities.applyMany([orderFrame(uuid(3), 6)]);
    expect(popup.getState().queue).toEqual([]);
  });

  test('sign-out empties the queue but keeps the choice; unbind stops listening', async () => {
    const { entities, popup, unbind } = setup();
    await popup.setEnabled(true);
    entities.apply(paymentAlertFrame(uuid(1), uuid(10)));
    popup.reset();
    expect(popup.getState()).toMatchObject({ enabled: true, queue: [] });
    unbind();
    entities.apply(paymentAlertFrame(uuid(2), uuid(11)));
    expect(popup.getState().queue).toEqual([]);
  });
});
