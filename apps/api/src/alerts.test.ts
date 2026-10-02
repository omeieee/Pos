import { describe, expect, test } from 'vitest';
import { type AlertReport, alertReport, forwardAlerts } from './alerts.ts';
import { type AppEvent, createEventBus, type SecurityAlertEvent } from './events.ts';

const alert = (over: Partial<SecurityAlertEvent> = {}): SecurityAlertEvent => ({
  type: 'alert.security',
  kind: 'owner.login_locked',
  severity: 'critical',
  at: '2026-10-01T03:00:00.000Z',
  staffId: '0192f3a0-0000-7000-8000-000000000001',
  deviceId: '0192f3a0-0000-7000-8000-000000000002',
  ...over,
});

function wire() {
  const bus = createEventBus();
  const reports: AlertReport[] = [];
  forwardAlerts(bus, (r) => void reports.push(r));
  return { bus, reports };
}

describe('forwardAlerts (security alerts to Sentry)', () => {
  test('sends warn and critical alerts, not info', () => {
    const { bus, reports } = wire();
    bus.publish(alert({ severity: 'critical', kind: 'owner.login_locked' }));
    bus.publish(alert({ severity: 'warn', kind: 'device.registered' }));
    bus.publish(alert({ severity: 'info', kind: 'something.minor' }));
    expect(reports.map((r) => [r.tags.alert, r.level])).toEqual([
      ['owner.login_locked', 'error'],
      ['device.registered', 'warning'],
    ]);
  });

  test('ignores events that are not security alerts', () => {
    const { bus, reports } = wire();
    const other: AppEvent = {
      type: 'alert.new_order',
      orderId: crypto.randomUUID(),
      orderNo: 'S-001',
      channel: 'storefront',
      status: 'preparing',
      createdOnDeviceId: null,
    };
    bus.publish(other);
    expect(reports).toEqual([]);
  });

  test('the report holds the event name and ids only', () => {
    const report = alertReport(alert());
    expect(report).toEqual({
      message: 'security alert: owner.login_locked',
      level: 'error',
      tags: { alert: 'owner.login_locked', severity: 'critical' },
      extra: {
        staffId: '0192f3a0-0000-7000-8000-000000000001',
        deviceId: '0192f3a0-0000-7000-8000-000000000002',
      },
    });
  });

  test('a payment alert adds the payment and order ids, and nothing else', () => {
    const report = alertReport(
      alert({
        kind: 'payment.voided',
        subject: { paymentId: 'pay-1', orderId: 'ord-1', amountSatang: 5000 } as never,
      }),
    );
    expect(report.extra).toEqual({
      staffId: '0192f3a0-0000-7000-8000-000000000001',
      deviceId: '0192f3a0-0000-7000-8000-000000000002',
      paymentId: 'pay-1',
      orderId: 'ord-1',
    });
  });

  test('a PromptPay ID change adds the count of open PromptPay payments, and nothing else', () => {
    const report = alertReport(
      alert({
        kind: 'settings.promptpay_changed',
        detail: { openPromptpayPayments: 3, idValue: '0899994321' } as never,
      }),
    );
    expect(report.extra).toEqual({
      staffId: '0192f3a0-0000-7000-8000-000000000001',
      deviceId: '0192f3a0-0000-7000-8000-000000000002',
      openPromptpayPayments: 3,
    });
    expect(JSON.stringify(report)).not.toContain('0899994321');
  });

  test('missing ids stay null', () => {
    expect(alertReport(alert({ staffId: null, deviceId: null })).extra).toEqual({
      staffId: null,
      deviceId: null,
    });
  });

  test('a failing reporter does not break the bus or the other subscribers', async () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    forwardAlerts(bus, () => {
      throw new Error('sentry is down');
    });
    const seen: AppEvent[] = [];
    bus.subscribe((e) => void seen.push(e));
    expect(() => bus.publish(alert())).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
