import { describe, expect, test } from 'vitest';
import { type AppEvent, createEventBus } from './events.ts';

const event: AppEvent = {
  type: 'alert.security',
  kind: 'device.registered',
  severity: 'warn',
  at: '2026-10-01T03:00:00.000Z',
  staffId: null,
  deviceId: null,
};

describe('event bus', () => {
  test('delivers to every subscriber until they unsubscribe', () => {
    const bus = createEventBus();
    const a: AppEvent[] = [];
    const b: AppEvent[] = [];
    const stopA = bus.subscribe((e) => void a.push(e));
    bus.subscribe((e) => void b.push(e));
    bus.publish(event);
    stopA();
    bus.publish(event);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  test('a throwing subscriber does not stop the others or the publisher', () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    const seen: AppEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => void seen.push(e));
    expect(() => bus.publish(event)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test('a rejecting async subscriber is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });
});
