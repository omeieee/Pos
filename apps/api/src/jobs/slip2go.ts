import { securityAlert } from '../auth/service.ts';
import { activeSlipVerifier } from '../slips/slip2go.ts';
import type { JobDeps } from './jobs.ts';

/** Fewer slips left than this, and the owner is told. */
export const SLIP2GO_LOW_QUOTA = 30;
/** A package that ends within this many days (or has ended) is flagged. */
export const SLIP2GO_EXPIRY_WARN_DAYS = 3;

/**
 * The daily look at the Slip2Go account (D-27): how many slips are left and when the package ends.
 * The call is not charged. The owner gets a `warn` alert when either runs low, with the number or
 * the date only. A failed call is counted and left for the next day (a real outage shows up in the
 * checks themselves). A no-op when the verifier is off.
 */
export async function checkSlip2goAccount(deps: JobDeps): Promise<Record<string, number>> {
  const verifier = activeSlipVerifier();
  if (!verifier) return { checked: 0, failed: 0, alerts: 0 };
  const info = await verifier.accountInfo();
  if (info.kind === 'failed') return { checked: 0, failed: 1, alerts: 0 };
  let alerts = 0;
  const alert = (kind: string, slip2go: { quotaSlips?: number; expiresOn?: string }) => {
    deps.events.publish(securityAlert({ now: deps.now }, kind, 'warn', { slip2go }));
    alerts += 1;
  };
  if (info.estimatedQuotaSlip !== null && info.estimatedQuotaSlip < SLIP2GO_LOW_QUOTA) {
    alert('slip2go.quota_low', { quotaSlips: info.estimatedQuotaSlip });
  }
  if (info.packageExpiredDate !== null) {
    const ends = new Date(info.packageExpiredDate);
    const warnFrom = deps.now().getTime() + SLIP2GO_EXPIRY_WARN_DAYS * 86_400_000;
    if (!Number.isNaN(ends.getTime()) && ends.getTime() <= warnFrom) {
      alert('slip2go.package_expiring', { expiresOn: ends.toISOString().slice(0, 10) });
    }
  }
  return { checked: 1, failed: 0, alerts };
}
