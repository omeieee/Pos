import { PAYMENT_ALERT_KINDS, STAFF_ROLES } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import type { AppEvent } from '../events.ts';
import { frameForRole, frameFromEvent, mayReceive } from './frames.ts';

const ORDER_ID = '0192e0a0-0000-7000-8000-000000000001';

describe('alert.payment frame (D-42)', () => {
  for (const kind of PAYMENT_ALERT_KINDS) {
    test(`${kind}: ids and the order number only, for every staff role`, () => {
      const event = {
        type: 'alert.payment',
        orderId: ORDER_ID,
        orderNo: 'L-012',
        kind,
        // Anything a producer adds by mistake must not reach a device.
        recipientName: 'ลูกค้า',
      } as AppEvent;
      const built = frameFromEvent(event);
      expect(built.kind).toBe('frame');
      if (built.kind !== 'frame') return;
      expect(built.frame).toEqual({
        type: 'alert.payment',
        id: ORDER_ID,
        data: { orderId: ORDER_ID, orderNo: 'L-012', kind },
      });
      for (const role of STAFF_ROLES) {
        expect(mayReceive(role, built.frame)).toBe(true);
        expect(frameForRole(role, built.frame)).toBe(built.frame);
      }
    });
  }

  test('a bad order id is dropped, not sent', () => {
    const built = frameFromEvent({
      type: 'alert.payment',
      orderId: 'not-a-uuid',
      orderNo: 'L-1',
      kind: 'paid',
    });
    expect(built).toEqual({ kind: 'invalid', type: 'alert.payment' });
  });
});
