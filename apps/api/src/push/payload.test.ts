import { ORDER_CHANNELS, pushPayloadSchema } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { newOrderPayload } from './payload.ts';

const id = '00000000-0000-4000-8000-000000000001';

describe('newOrderPayload', () => {
  test('names the order number and the channel, counts items and links to the order', () => {
    expect(newOrderPayload({ id, orderNo: 'L-012', channel: 'line' }, 3)).toEqual({
      title: 'ออเดอร์ใหม่ #L-012 (LINE)',
      body: '3 รายการ',
      url: `/#/orders/${id}`,
      tag: `order-${id}`,
    });
  });

  test('has a Thai channel name for every channel and always satisfies the payload schema', () => {
    for (const channel of ORDER_CHANNELS) {
      const payload = newOrderPayload({ id, orderNo: 'X-001', channel }, 1);
      expect(pushPayloadSchema.safeParse(payload).success, channel).toBe(true);
      expect(payload.title).not.toContain('orders.channel');
    }
  });

  test('an order with no live items has an empty body', () => {
    expect(newOrderPayload({ id, orderNo: 'S-001', channel: 'storefront' }, 0).body).toBe('');
  });
});
