/**
 * Payments: the slip columns a payment gets when a slip is attached, replaced or cleared.
 */
import type { paymentsRepo } from '@sds/db';
import { type SlipVerifyVerdict, slipCycleAvailable, slipResendRechecks } from '@sds/shared';

/**
 * A new slip: its key, with the old readings cleared (and new ones asked for when they are on).
 * The same picture again on a payment that already has a bank verdict keeps that verdict and the
 * QR key it filled (D-27): re-sending the same file must not spend another call, except after a
 * final "not found" or "unchecked" at least a minute after the last call (`slipResendRechecks`).
 */
export const slipPatch = (
  slip: {
    key: string;
    hash: string;
    ocr?: boolean;
    verify?: boolean;
    autoConfirmBlocked?: boolean;
  },
  current: paymentsRepo.PaymentRow,
  now: Date,
): paymentsRepo.PaymentPatch => {
  const checks = Boolean(slip.verify) && slipCycleAvailable(current.slipVerifyCycles);
  return {
    slipImageKey: slip.key,
    slipCheck: slip.ocr ? 'pending' : null,
    slipAmountSatang: null,
    // The picture's hash is kept for the duplicate hint; the reference hash comes with the reading.
    slipImageHash: slip.hash,
    slipRefHash: null,
    slipRecipientCheck: null,
    // D-40: per picture. A slip the server could not match to one order is staff's to confirm.
    slipAutoconfirmBlocked: Boolean(slip.autoConfirmBlocked),
    ...(current.slipImageHash === slip.hash &&
    current.slipVerify !== null &&
    // A final "not found" or "unchecked" and a last call a minute ago: sending the picture again is
    // a fresh check (a slow bank has had time), so the old answer is not kept.
    !(
      slip.verify &&
      slipResendRechecks(
        {
          verdict: current.slipVerify as SlipVerifyVerdict,
          verifiedAt: current.slipVerifiedAt,
          blockedAt: current.slipBlockedAt,
          reviewedAt: current.slipReviewedAt,
          cycles: current.slipVerifyCycles,
        },
        now,
      )
    )
      ? {}
      : {
          slipQrHash: null,
          // A payment has at most 1 + SLIP_RESEND_RECHECKS_MAX check cycles for life, whatever the
          // pictures: beyond that a fresh picture is stored but gets no bank check (staff verify it).
          slipVerify: checks ? 'pending' : null,
          slipVerifyCode: null,
          slipVerifyRef: null,
          slipVerifyAttempts: 0,
          slipStaffCalls: 0,
          ...(checks ? { slipVerifyCycles: current.slipVerifyCycles + 1 } : {}),
          slipVerifiedAt: null,
          slipUploadedAt: now,
          // The owner's review was of the earlier picture, not of this one.
          slipReviewedAt: null,
        }),
  };
};
