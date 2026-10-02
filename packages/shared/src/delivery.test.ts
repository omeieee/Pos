import { describe, expect, test } from 'vitest';
import { allowedFulfillments } from './delivery.ts';
import { FULFILLMENTS, ORDER_CHANNELS } from './enums.ts';

describe('allowedFulfillments (owner, 2026-10-02: delivery to the building entrance only)', () => {
  test.each(['storefront', 'line', 'phone'] as const)(
    '%s orders go to the building entrance and nothing else',
    (channel) => {
      expect(allowedFulfillments(channel)).toEqual(['entrance_delivery']);
    },
  );

  test.each(['grab', 'lineman'] as const)('%s orders are delivered by the platform', (channel) => {
    expect(allowedFulfillments(channel)).toEqual(['platform_delivery']);
  });

  test('every channel has exactly one way to be served, and it is a known fulfilment', () => {
    for (const channel of ORDER_CHANNELS) {
      const allowed = allowedFulfillments(channel);
      expect(allowed).toHaveLength(1);
      expect(FULFILLMENTS).toContain(allowed[0]);
    }
  });

  test('the old counter fulfilments are never offered, but stay valid values for history', () => {
    for (const channel of ORDER_CHANNELS) {
      for (const legacy of ['dine_in', 'takeaway', 'pickup', 'room_delivery'] as const) {
        expect(allowedFulfillments(channel)).not.toContain(legacy);
        expect(FULFILLMENTS).toContain(legacy);
      }
    }
  });
});
