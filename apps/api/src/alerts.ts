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
  };
}

export function alertReport(event: SecurityAlertEvent): AlertReport {
  return {
    message: `security alert: ${event.kind}`,
    level: event.severity === 'critical' ? 'error' : 'warning',
    tags: { alert: event.kind, severity: event.severity },
    extra: {
      staffId: event.staffId,
      deviceId: event.deviceId,
      // Picked field by field: nothing else of `subject` can ride along.
      ...(event.subject
        ? { paymentId: event.subject.paymentId, orderId: event.subject.orderId }
        : {}),
    },
  };
}

/**
 * Until ntfy exists (P8), warn and critical security alerts reach the owner through Sentry's
 * e-mail alerts. In Sentry, give the project an alert rule that fires on every event tagged
 * `alert`; the default "new issue" rule would mail only the first occurrence of each kind.
 */
export function forwardAlerts(bus: EventBus, report: (report: AlertReport) => void): void {
  bus.subscribe((event) => {
    if (event.type !== 'alert.security' || event.severity === 'info') return;
    report(alertReport(event));
  });
}
