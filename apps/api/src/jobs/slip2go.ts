import { paymentsRepo } from '@sds/db';
import { securityAlert } from '../auth/service.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { activeSlipVerifier } from '../slips/slip2go.ts';
import type { JobDeps } from './jobs.ts';

/** Fewer slips left than this, and the owner is told. */
export const SLIP2GO_LOW_QUOTA = 30;
/** A package that ends within this many days (or has ended) is flagged. */
export const SLIP2GO_EXPIRY_WARN_DAYS = 3;

/**
 * The daily look at the Slip2Go account (D-27): how many slips are left and when the package ends.
 * The call is not charged. The owner gets a `warn` alert when either runs low, with the number or
 * the date only. A failed call (network, timeout, an unreadable answer, or a code other than
 * `200001`: expired package, no tokens, IP not allowed) raises the `slip2go.unavailable` alert
 * (PAY-02), the same once-a-business-date alert the slip checks raise, with Slip2Go's 6-digit code
 * only. A no-op when the verifier is off.
 */
export async function checkSlip2goAccount(deps: JobDeps): Promise<Record<string, number>> {
  const verifier = activeSlipVerifier();
  if (!verifier) return { checked: 0, failed: 0, alerts: 0 };
  const info = await verifier.accountInfo();
  if (info.kind === 'failed') {
    const day = await currentBusinessDate(deps.db, deps.now());
    // The claim is its own committed insert: the alert goes out after it, and once a business date.
    if (!(await paymentsRepo.claimSlipVerifyAlert(deps.db, day, 'account'))) {
      return { checked: 0, failed: 1, alerts: 0 };
    }
    const code = info.code && /^\d{6}$/.test(info.code) ? info.code : undefined;
    deps.events.publish(
      securityAlert({ now: deps.now }, 'slip2go.unavailable', 'warn', {
        slip2go: code ? { code } : {},
      }),
    );
    return { checked: 0, failed: 1, alerts: 1 };
  }
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
