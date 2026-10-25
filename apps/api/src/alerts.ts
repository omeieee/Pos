import type { EventBus, SecurityAlertEvent } from './events.ts';

/**
 * What goes to Sentry for a security alert: the event name and the ids, nothing else. A fixed
 * shape on purpose, so a field added to an event later cannot leak by being copied along.
 */
export interface AlertReport {
  message: string;
  level: 'warning' | 'error';
  tags: { alert: string; severity: SecurityAlertEvent['severity'] };
  extra: {
    staffId: string | null;
    deviceId: string | null;
    paymentId?: string;
    orderId?: string;
    orderNo?: string;
    openPromptpayPayments?: number;
    slip2go?: { code?: string; quotaSlips?: number; expiresOn?: string };
  };
}

export function alertReport(event: SecurityAlertEvent): AlertReport {
  return {
    message:
      event.kind === 'slip.fraud_blocked' && event.orderNo
        ? `security alert: ${event.kind} (order ${event.orderNo}: suspected fake slip, order blocked, staff must verify by hand)`
        : `security alert: ${event.kind}`,
    level: event.severity === 'critical' ? 'error' : 'warning',
    tags: { alert: event.kind, severity: event.severity },
    extra: {
      staffId: event.staffId,
      deviceId: event.deviceId,
      // Picked field by field: nothing else of `subject` can ride along.
      ...(event.subject
        ? {
            ...(event.subject.paymentId ? { paymentId: event.subject.paymentId } : {}),
            orderId: event.subject.orderId,
          }
        : {}),
      ...(event.orderNo ? { orderNo: event.orderNo } : {}),
      ...(event.detail ? { openPromptpayPayments: event.detail.openPromptpayPayments } : {}),
      // Picked field by field too: a result code, slips left and a date, nothing else.
      ...(event.slip2go
        ? {
            slip2go: {
              ...(event.slip2go.code !== undefined ? { code: event.slip2go.code } : {}),
              ...(event.slip2go.quotaSlips !== undefined
                ? { quotaSlips: event.slip2go.quotaSlips }
                : {}),
              ...(event.slip2go.expiresOn !== undefined
                ? { expiresOn: event.slip2go.expiresOn }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Warn and critical security alerts reach the owner through Sentry's e-mail alerts, and also by
 * Web Push to owner and manager devices when push is set up (`push/notifier.ts`, OPS-02). In
 * Sentry, give the project an alert rule that fires on every event tagged `alert`; the default
 * "new issue" rule would mail only the first occurrence of each kind.
 */
export function forwardAlerts(bus: EventBus, report: (report: AlertReport) => void): void {
  bus.subscribe((event) => {
    if (event.type !== 'alert.security' || event.severity === 'info') return;
    report(alertReport(event));
  });
}
