import { createHash } from 'node:crypto';
import { customersRepo, type Db, insertAudit, ordersRepo, paymentsRepo } from '@sds/db';
import {
  checkSlipRecipient,
  compareSlipAmount,
  extractSlipAmount,
  extractSlipRef,
  inSlipNotFoundGrace,
  isInvalidSlipVerdict,
  SLIP_GRACE_RETRY_DELAYS_MS,
  SLIP_NOT_FOUND_GRACE_MAX_CALLS,
  SLIP_NOT_FOUND_GRACE_SECONDS,
  type SlipCheck,
  type SlipRecipientCheck,
  type SlipVerifyResult,
  type SlipVerifyVerdict,
  slip2goAutoConfirmReceivers,
  slip2goReceivers,
  slip2goVerdict,
  slipQrKeyText,
} from '@sds/shared';
import { securityAlert } from '../auth/service.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { toPaymentDto } from '../payments/dto.ts';
import { autoConfirmClaimedPayment } from '../payments/service.ts';
import {
  currentBankAccount,
  currentBankAccountNumber,
  currentPromptpayId,
} from '../settings/service.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { imageSize, sniffSlip } from './image.ts';
import type { SlipOcr } from './ocr.ts';
import type { SlipQrReader } from './qr.ts';
import type { SlipVerifier } from './slip2go.ts';
import type { SlipStore } from './store.ts';

/**
 * The automatic reading of a slip. Two independent readings, each switched on by its own setting,
 * each with its own `pending` mark on the payment:
 *
 * - the amount on the picture (D-26, Tesseract OCR, `slip_check`);
 * - the bank check by Slip2Go (D-27, `slip_verify`): does the transfer exist, did it go to the
 *   shop, is it this payment's amount, is it newer than the order.
 *
 * Both are only hints on the payment: they never confirm or reject money (CLAUDE.md rule 2) except
 * for the one automatic confirmation D-27 allows (`autoConfirm`, off unless configured), and never
 * fail an upload. They keep only verdicts, words, hashes and Slip2Go's result code and reference:
 * the OCR text, the QR text, names and account numbers are dropped at once.
 */
export interface SlipChecker {
  /** Which readings this checker does; the upload marks a new slip `pending` for exactly these. */
  readonly wants: { readonly ocr: boolean; readonly verify: boolean };
  /** Reads the slip of this payment soon, one at a time. Never throws. */
  enqueue(paymentId: string): void;
  /** Reads the payments still marked pending (after a restart, or a full queue). Returns how many were read. */
  sweep(limit?: number): Promise<number>;
  /** Resolves when everything queued so far is done (tests, shutdown). */
  idle(): Promise<void>;
  /**
   * Why a staff recheck of this payment's bank check must not start now: the attempts of this
   * picture are used up, or today's Slip2Go calls are. Null when it may go ahead. Nothing is written.
   */
  recheckBlocker(row: paymentsRepo.PaymentRow, db?: Db): Promise<'attempts' | 'cap' | null>;
  /**
   * Runs the bank check of a payment the staff marked `pending` again, and resolves when that one
   * payment is done (not the whole queue). The attempt ceiling is the automatic one plus
   * STAFF_RECHECK_EXTRA_ATTEMPTS, and a failed call settles as `unchecked` at once, so one press
   * is at most one call. Everything else (D-27 conditions, auto-confirm) is the same path.
   */
  recheck(paymentId: string, previous: VerdictSnapshot): Promise<void>;
}

/**
 * The bank verdict a payment had before staff cleared it for a recheck. If the check is then
 * refused inside the checker (the day's cap or the attempts ran out in between), this is written
 * back, so a payment is never left with no verdict because of a check that was not made.
 */
export interface VerdictSnapshot {
  verdict: SlipVerifyVerdict | null;
  code: string | null;
  ref: string | null;
  at: Date | null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** More pixels than this are not decoded: a phone screenshot is about 3 million. */
export const MAX_OCR_PIXELS = 16_000_000;
/** Beyond this many waiting, the rest is left to the sweep. */
const MAX_QUEUED = 50;
const SWEEP_LIMIT = 5;
/** Calls to Slip2Go per slip when it keeps failing (network, 429, 5xx, bank error), then `unchecked`. */
export const MAX_VERIFY_ATTEMPTS = 3;
/** Staff may press "check again" until a picture has had this many calls more than the automatic ones: 3 + 3 = 6 in all. */
export const STAFF_RECHECK_EXTRA_ATTEMPTS = 3;
export const MAX_VERIFY_ATTEMPTS_STAFF = MAX_VERIFY_ATTEMPTS + STAFF_RECHECK_EXTRA_ATTEMPTS;
/** The code a picture carries while (and after) it is in its not-found grace budget. */
const NOT_FOUND_CODE = '200404';
/**
 * The calls one picture may have on its own: the 3 of an error, or, once a "not found" has been
 * answered (the code is kept), the grace budget of 6. Staff's recheck comes on top of either.
 */
const autoCeiling = (code: string | null): number =>
  code === NOT_FOUND_CODE ? SLIP_NOT_FOUND_GRACE_MAX_CALLS : MAX_VERIFY_ATTEMPTS;
/**
 * Where staff's presses stop: the automatic calls this picture really had (at least 3), plus the
 * extra ones. A picture in its not-found state that had only 1 call is thus capped at 6, not 9.
 * `autoCalls` is the attempts minus the staff's own (they are counted apart), so that staff's
 * presses never move the ceiling up.
 */
const staffCeiling = (code: string | null, autoCalls: number): number =>
  (code === NOT_FOUND_CODE ? Math.max(autoCalls, MAX_VERIFY_ATTEMPTS) : MAX_VERIFY_ATTEMPTS) +
  STAFF_RECHECK_EXTRA_ATTEMPTS;
/** The transfer may predate the order a little (the customer paid while the cart was open). */
const DATE_SLACK_MS = 10 * 60_000;
export const DEFAULT_DAILY_CAP = 100;
/**
 * Least time between two calls for a slip whose "not found" is inside the grace window. The sweep
 * runs every minute, so a retry lands on the first tick at least this long after the last call
 * (about a minute apart, never in a loop).
 */
export const NOT_FOUND_RETRY_GAP_MS = 30_000;

/** What the bank check decided for one picture. */
type VerifyOutcome =
  | {
      kind: 'final';
      verdict: SlipVerifyResult;
      code: string | null;
      ref: string | null;
      /** A call was made (it counts as an attempt). */
      called: boolean;
      /** Every receiver sent is one an automatic confirmation is allowed for (proven live only). */
      receiversOk: boolean;
      /** Which owner alert this answer calls for, once per business date. */
      alert: 'account' | 'cap' | null;
    }
  | {
      kind: 'retry';
      code: string | null;
      alert: null;
      /** A "not found" inside the grace window: the answer is not final yet, the payment stays pending. */
      grace?: boolean;
    };

interface Evaluated {
  ocr: {
    check: Exclude<SlipCheck, 'pending'>;
    amount: number | null;
    refHash: string | null;
    recipient: SlipRecipientCheck | null;
  } | null;
  verify: VerifyOutcome | null;
  /**
   * The duplicate key to store. On a valid bank answer it is Slip2Go's own (so that every
   * automatically confirmed row shares one format), else the local QR decode, else Slip2Go's.
   */
  qrHash: string | null;
  /** The key built from Slip2Go's answer; an automatic confirmation needs it. */
  remoteHash: string | null;
  businessDate: string;
}

export function createSlipChecker(args: {
  ctx: CoreContext;
  slips: SlipStore;
  /** Reads the amount on the picture (D-26). Without it only the bank check runs. */
  ocr?: SlipOcr;
  /** Reads the slip's small QR (D-26); it also supplies the QR text for the bank check. */
  qr?: SlipQrReader;
  /** The bank check by Slip2Go (D-27). */
  verifier?: SlipVerifier;
  /** Calls to the verifier per business date; above it a slip is left to the staff tick. */
  dailyCap?: number;
  /**
   * D-27: confirm a PromptPay payment by itself on a valid bank check, up to this amount in satang.
   * Null or absent: never (the default). Needs the verifier.
   */
  autoConfirm?: { maxSatang: number } | null;
  /** The not-found grace window in seconds (default SLIP_NOT_FOUND_GRACE_SECONDS); 0 turns it off. */
  notFoundGraceSeconds?: number;
  /** Wait this long after an upload before the first bank call (the bank may not know a fresh transfer yet). 0 = at once. */
  firstCallDelayMs?: number;
  /**
   * Waits between the grace calls of a "not found" (default SLIP_GRACE_RETRY_DELAYS_MS): an in-process
   * timer fires each next call. Empty: no timers, the minute sweep drives the retries alone.
   */
  graceRetryDelaysMs?: readonly number[];
  /** Counts and ids only: never the text. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}): SlipChecker {
  const { ctx, slips, ocr, qr, verifier } = args;
  if (!ocr && !verifier) throw new Error('a slip checker needs the OCR or the verifier');
  const dailyCap = args.dailyCap ?? DEFAULT_DAILY_CAP;
  const graceSeconds = args.notFoundGraceSeconds ?? SLIP_NOT_FOUND_GRACE_SECONDS;
  const waiting = new Set<string>();
  /** A new slip arrived for a payment that is being read: read it again when this one ends. */
  const again = new Set<string>();
  /**
   * Payments whose read in progress was asked for by staff: a higher ceiling, no second try, and
   * the verdict to put back if the check is refused. Their result does not count toward the cooldown.
   */
  const manual = new Map<string, VerdictSnapshot>();
  /** Per picture: the earliest time of the next grace retry (this process only; a restart just retries sooner). */
  const retryNotBefore = new Map<string, number>();
  /** Payments with a grace retry timer pending: the sweep leaves them to it. */
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Payments whose timer just fired: that read skips the sweep's gap rule. */
  const timerDue = new Set<string>();
  const retryDelays = args.graceRetryDelaysMs ?? SLIP_GRACE_RETRY_DELAYS_MS;
  let tail: Promise<void> = Promise.resolve();

  async function readOcr(bytes: Buffer, expected: number): Promise<NonNullable<Evaluated['ocr']>> {
    if (!ocr) throw new Error('no OCR');
    let text: string;
    try {
      text = await ocr.read(bytes);
    } catch (error) {
      // The class of the failure only: the message of a reader could echo what it read.
      args.log?.warn({ reason: error instanceof Error ? error.message : 'OCR_FAILED' }, 'slip OCR');
      return { check: 'unreadable', amount: null, refHash: null, recipient: null };
    }
    const amount = extractSlipAmount(text);
    // Only the hash of the normalised reference leaves this function: two slips of one transfer
    // share it, and it shows nothing if the database is read.
    const ref = extractSlipRef(text);
    const refHash = ref ? sha256(ref) : null;
    // The receiver: compared with the PromptPay ID and the receiving bank account in force now.
    // Only the word is kept; nothing set, or a failed settings read, just means no answer (it must
    // never fail the amount check).
    let recipient: SlipRecipientCheck | null = null;
    try {
      const id = await currentPromptpayId(ctx.db);
      const accountNumber = await currentBankAccountNumber(ctx.db);
      if (id || accountNumber) {
        recipient = checkSlipRecipient(text, id, accountNumber ? { accountNumber } : null);
      }
    } catch {
      args.log?.warn({}, 'slip recipient');
    }
    return { check: compareSlipAmount(amount, expected), amount, refHash, recipient };
  }

  /** `code` is the picture's code as the automatic reading left it (a staff recheck clears it, so its snapshot has it). */
  const attemptCeiling = (
    paymentId: string,
    code: string | null,
    row: { slipVerifyAttempts: number; slipStaffCalls: number },
  ) => {
    const snapshot = manual.get(paymentId);
    return snapshot
      ? staffCeiling(snapshot.code, row.slipVerifyAttempts - row.slipStaffCalls)
      : autoCeiling(code);
  };

  /** The bank check: one call to Slip2Go, or a reason not to make it. */
  async function readVerify(
    row: paymentsRepo.PaymentRow,
    bytes: Buffer | null,
    usable: boolean,
    rawQr: string | null,
    businessDate: string,
  ): Promise<{ outcome: VerifyOutcome; qrHash: string | null }> {
    if (!verifier) throw new Error('no verifier');
    const noCall = (alert: 'cap' | null = null) => ({
      outcome: {
        kind: 'final' as const,
        verdict: 'unchecked' as const,
        code: null,
        ref: null,
        called: false,
        receiversOk: false,
        alert,
      },
      qrHash: null,
    });
    // The payment is no longer waiting for a decision (cancelled, voided, confirmed): no call.
    if (row.status !== 'claimed') return noCall();
    // A "not found" that was kept pending (grace): once its window has closed or its calls are used
    // up, the last 404 is the answer. No call is spent; counted once toward the cooldown.
    if (
      !manual.has(row.id) &&
      row.slipVerifyCode === NOT_FOUND_CODE &&
      (row.slipVerifyAttempts >= SLIP_NOT_FOUND_GRACE_MAX_CALLS ||
        !inSlipNotFoundGrace(row.slipUploadedAt, ctx.now(), graceSeconds))
    ) {
      return {
        outcome: {
          kind: 'final' as const,
          verdict: 'not_found' as const,
          code: NOT_FOUND_CODE,
          ref: null,
          called: true,
          receiversOk: false,
          alert: null,
        },
        qrHash: null,
      };
    }
    // Calls already made for this picture that never reached a verdict (a commit that failed
    // after the answer, or retries): at most 3 (6 in its not-found grace), then unchecked.
    if (row.slipVerifyAttempts >= attemptCeiling(row.id, row.slipVerifyCode, row)) return noCall();
    const mime = bytes ? sniffSlip(bytes) : null;
    // The QR text goes first (no picture leaves the machine); the picture only when no QR was read,
    // and only as JPEG or PNG (Slip2Go documents nothing else).
    const image = !rawQr && usable && bytes && (mime === 'image/jpeg' || mime === 'image/png');
    if (!rawQr && !image) return noCall();
    const promptpay = await currentPromptpayId(ctx.db);
    const bank = await currentBankAccount(ctx.db);
    // Nothing to check the receiver against: a call would let a transfer to anyone pass.
    const receivers = slip2goReceivers(promptpay?.idValue ?? null, bank);
    if (receivers.length === 0) return noCall();
    const order = await ordersRepo.findOrderById(ctx.db, row.orderId);
    if (!order) return noCall();
    const conditions = {
      amountSatang: row.amountSatang,
      receivers,
      notBefore: new Date(order.placedAt.getTime() - DATE_SLACK_MS),
    };
    // The cap counts calls in its own table, so replacing the slip over and over cannot hide them.
    if ((await paymentsRepo.slipVerifyCallsOn(ctx.db, businessDate)) >= dailyCap)
      return noCall('cap');
    // The attempt is counted BEFORE the call, on its own, so that a commit that fails after the
    // answer cannot make the same slip be sent every minute. Null: the slip was replaced meanwhile.
    const attempt = await paymentsRepo.bumpSlipVerifyAttempts(
      ctx.db,
      row.id,
      row.slipImageHash,
      manual.has(row.id),
    );
    if (attempt === null) return noCall();
    await paymentsRepo.recordSlipVerifyCall(ctx.db, businessDate);
    const result = rawQr
      ? await verifier.verifyQr(rawQr, conditions)
      : await verifier.verifyImage(bytes as Buffer, mime as string, conditions);
    if (result.kind === 'transient') {
      return { outcome: { kind: 'retry', code: null, alert: null }, qrHash: null };
    }
    // Rule 1: the amount Slip2Go reports is compared with the payment's own, in satang. A valid that
    // reports no amount, or another one, is not valid.
    const localAmountOk =
      result.code === '200200' ? result.amountSatang === row.amountSatang : null;
    const decided = slip2goVerdict(result.code, localAmountOk);
    const code = /^\d{6}$/.test(result.code) ? result.code : null;
    // The duplicate key, built exactly like the local one so that the two can meet.
    const keyText =
      result.transRef && result.senderBank
        ? slipQrKeyText(result.senderBank, result.transRef)
        : null;
    const qrHash = keyText ? sha256(keyText) : null;
    if (decided.retry) return { outcome: { kind: 'retry', code, alert: null }, qrHash };
    // Banks can be slow to publish a transfer: a first "not found" of a fresh slip is asked again
    // later, within the grace budget of its own (the last answer is always final), never for staff's recheck.
    if (
      result.code === NOT_FOUND_CODE &&
      !manual.has(row.id) &&
      attempt < SLIP_NOT_FOUND_GRACE_MAX_CALLS &&
      inSlipNotFoundGrace(row.slipUploadedAt, ctx.now(), graceSeconds)
    ) {
      return { outcome: { kind: 'retry', code, alert: null, grace: true }, qrHash };
    }
    return {
      outcome: {
        kind: 'final',
        verdict: decided.verdict,
        code,
        ref: result.referenceId ? result.referenceId.slice(0, 100) : null,
        called: true,
        receiversOk: slip2goAutoConfirmReceivers(receivers),
        alert: decided.alert ? 'account' : null,
      },
      qrHash,
    };
  }

  async function evaluate(
    row: paymentsRepo.PaymentRow,
    key: string,
    wantOcr: boolean,
    wantVerify: boolean,
  ): Promise<Evaluated> {
    const businessDate = await currentBusinessDate(ctx.db, ctx.now());
    const bytes = await slips.get(key);
    const size = bytes ? imageSize(bytes) : null;
    const usable = Boolean(bytes && size && size.width * size.height <= MAX_OCR_PIXELS);
    // The small QR first: it is cheap, it works on screenshots and re-photos, and it still counts
    // when the text cannot be read. A failure here only means "no QR key"; it never fails the check.
    let localHash: string | null = null;
    let rawQr: string | null = null;
    if (qr && bytes && usable) {
      try {
        const found = qr.readRaw ? await qr.readRaw(bytes) : null;
        const parsed = qr.readRaw ? (found?.qr ?? null) : await qr.read(bytes);
        const keyText = parsed ? slipQrKeyText(parsed.sendingBank, parsed.transRef) : null;
        if (keyText) localHash = sha256(keyText);
        // The text is for the bank check only and is dropped with this call.
        if (wantVerify && found) rawQr = found.raw;
      } catch (error) {
        args.log?.warn({ reason: error instanceof Error ? error.message : 'QR_FAILED' }, 'slip QR');
      }
    }
    const ocrPart = wantOcr
      ? bytes && usable
        ? await readOcr(bytes, row.amountSatang)
        : { check: 'unreadable' as const, amount: null, refHash: null, recipient: null }
      : null;
    let verifyPart: VerifyOutcome | null = null;
    let remoteHash: string | null = null;
    if (wantVerify) {
      const done = await readVerify(row, bytes ?? null, usable, rawQr, businessDate);
      verifyPart = done.outcome;
      remoteHash = done.qrHash;
    }
    return {
      ocr: ocrPart,
      verify: verifyPart,
      qrHash:
        verifyPart?.kind === 'final' && verifyPart.verdict === 'valid'
          ? (remoteHash ?? localHash)
          : (localHash ?? remoteHash),
      remoteHash,
      businessDate,
    };
  }

  async function read(paymentId: string): Promise<void> {
    const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
    if (!row?.slipImageKey) return;
    const wantOcr = Boolean(ocr) && row.slipCheck === 'pending';
    const wantVerify = Boolean(verifier) && row.slipVerify === 'pending';
    if (!wantOcr && !wantVerify) return;
    const key = row.slipImageKey;
    const hash = row.slipImageHash;
    // A "not found" that is still inside the grace window waits its turn: the sweep comes by again.
    const gate = `${paymentId}:${hash}`;
    const timerFired = timerDue.delete(paymentId);
    if (
      wantVerify &&
      !timerFired &&
      !manual.has(paymentId) &&
      (retryNotBefore.get(gate) ?? 0) > ctx.now().getTime()
    )
      return;
    const done = await evaluate(row, key, wantOcr, wantVerify);
    /** Set inside the transaction, acted on after it commits. */
    let nextRetryMs: number | null = null;
    await withTransaction(ctx, async (tx, emit) => {
      // Lock order, always: the order row, then the payment (see `payments/service.ts`).
      const order = await ordersRepo.lockOrderById(tx, row.orderId);
      const locked = await paymentsRepo.lockPaymentById(tx, paymentId);
      // The owner hears about the account once a day, even when this answer turns out stale.
      if (done.verify?.alert) {
        const first = await paymentsRepo.claimSlipVerifyAlert(
          tx,
          done.businessDate,
          done.verify.alert,
        );
        if (first) {
          emit(
            securityAlert(
              ctx,
              done.verify.alert === 'cap' ? 'slip2go.cap_reached' : 'slip2go.unavailable',
              'warn',
              {
                slip2go:
                  done.verify.alert === 'account' && done.verify.code
                    ? { code: done.verify.code }
                    : {},
              },
            ),
          );
        }
      }
      if (!locked) return;
      // A newer slip, or a purge, came in while the picture was being read: that answer is stale.
      // The amount reading follows the file; the bank check follows the picture (the same picture
      // sent again keeps its answer, so it must not be thrown away).
      const ocrFresh = wantOcr && locked.slipImageKey === key && locked.slipCheck === 'pending';
      const verifyFresh =
        wantVerify &&
        locked.slipImageKey !== null &&
        locked.slipImageHash === hash &&
        locked.slipVerify === 'pending';
      if (!ocrFresh && !verifyFresh) return;

      const patch: paymentsRepo.PaymentPatch = {};
      if (ocrFresh && done.ocr) {
        patch.slipCheck = done.ocr.check;
        patch.slipAmountSatang = done.ocr.amount;
        patch.slipRefHash = done.ocr.refHash;
        patch.slipRecipientCheck = done.ocr.recipient;
      }
      if (done.qrHash !== null) patch.slipQrHash = done.qrHash;
      if (verifyFresh && done.verify) {
        const outcome = done.verify;
        const previous = manual.get(paymentId);
        if (previous && outcome.kind === 'final' && !outcome.called) {
          // Staff asked for a check that was refused at the last step (the cap or the attempts ran
          // out meanwhile): no call was made, so the verdict they already had stays.
          patch.slipVerify = previous.verdict;
          patch.slipVerifyCode = previous.code;
          patch.slipVerifyRef = previous.ref;
          patch.slipVerifiedAt = previous.at;
        } else if (outcome.kind === 'retry') {
          // The attempt was counted before the call (`bumpSlipVerifyAttempts`).
          if (outcome.grace) {
            retryNotBefore.set(gate, ctx.now().getTime() + NOT_FOUND_RETRY_GAP_MS);
            // The mark that this picture is in its grace budget; it stays pending.
            patch.slipVerifyCode = NOT_FOUND_CODE;
            // The next call comes after the delay for this many calls made (the last delay repeats).
            nextRetryMs =
              retryDelays[Math.min(locked.slipVerifyAttempts, retryDelays.length) - 1] ?? null;
          }
          if (
            previous ||
            (!outcome.grace &&
              locked.slipVerifyAttempts >= attemptCeiling(paymentId, locked.slipVerifyCode, locked))
          ) {
            patch.slipVerify = 'unchecked';
            patch.slipVerifyCode = outcome.code;
            patch.slipVerifiedAt = ctx.now();
          }
        } else {
          retryNotBefore.delete(gate);
          patch.slipVerify = outcome.verdict;
          patch.slipVerifyCode = outcome.code;
          patch.slipVerifyRef = outcome.ref;
          patch.slipVerifiedAt = ctx.now();
          // A definitive failure counts toward the cooldown of the next slip; a staff recheck does not.
          if (outcome.called && !previous && isInvalidSlipVerdict(outcome.verdict)) {
            patch.slipInvalidCount = locked.slipInvalidCount + 1;
            patch.slipInvalidAt = ctx.now();
          }
          // "Fake slip" (code 200500 only): the order takes no more slips and the customer is
          // flagged for staff. Once per block; the audit row holds the reason word and the code.
          if (outcome.called && outcome.verdict === 'fraud' && locked.slipBlockedAt === null) {
            patch.slipBlockedAt = ctx.now();
            patch.slipBlockReason = 'fraud';
            patch.slipReviewedAt = null;
            if (order?.customerId) {
              await customersRepo.raiseSlipFlag(tx, order.customerId, ctx.now(), 'fraud');
            }
            await insertAudit(tx, {
              actorType: 'system',
              action: 'payment.slip_blocked',
              entity: 'payments',
              entityId: locked.id,
              after: { reason: 'fraud', code: outcome.code },
            });
            // The owner hears of every block: the order number only, no customer or slip data.
            if (order) {
              emit(
                securityAlert(ctx, 'slip.fraud_blocked', 'warn', {
                  subject: { orderId: order.id, paymentId: locked.id },
                  orderNo: order.orderNo,
                }),
              );
            }
          }
        }
      }
      // The one case where the status moves (D-27): a valid answer to a full call, every other
      // condition re-checked under the locks inside `autoConfirmClaimedPayment`.
      const outcome = done.verify;
      if (
        args.autoConfirm &&
        verifyFresh &&
        order &&
        outcome?.kind === 'final' &&
        outcome.called &&
        outcome.verdict === 'valid' &&
        outcome.code === '200200' &&
        // Only on conditions proven live: a transfer key from Slip2Go itself, and a receiver of
        // the proven form (the staff tick stays the path for everything else).
        done.remoteHash !== null &&
        outcome.receiversOk
      ) {
        const confirmed = await autoConfirmClaimedPayment(ctx, tx, emit, {
          order,
          payment: locked,
          patch,
          referenceId: outcome.ref,
          code: outcome.code,
          maxSatang: args.autoConfirm.maxSatang,
          refused: (reason) => args.log?.warn({ reason }, 'slip auto-confirm refused'),
        });
        // It wrote the payment and emitted its events itself; the plain write below is for the rest.
        if (confirmed) return;
      }
      if (
        args.autoConfirm &&
        outcome?.kind === 'final' &&
        outcome.verdict === 'valid' &&
        !(
          verifyFresh &&
          order &&
          outcome.called &&
          outcome.code === '200200' &&
          done.remoteHash !== null &&
          outcome.receiversOk
        )
      ) {
        args.log?.warn(
          {
            reason: 'before_gate',
            verifyFresh,
            hasOrder: Boolean(order),
            called: outcome.called,
            code: outcome.code,
            transferKey: done.remoteHash !== null,
            receiversOk: outcome.receiversOk,
          },
          'slip auto-confirm refused',
        );
      }
      const updated = await paymentsRepo.updatePaymentIfVersion(
        tx,
        locked.id,
        locked.version,
        patch,
      );
      // Without the case above the status is never touched. Devices get the new rev and ask for the hint.
      if (updated) {
        emit({
          type: 'payment.upserted',
          id: updated.id,
          rev: updated.rev,
          data: toPaymentDto(updated),
        });
      }
    });
    if (nextRetryMs !== null) armRetry(paymentId, nextRetryMs);
  }

  /** The next grace call, by timer (after commit). The same guard as `enqueue`: a busy payment reads again after. */
  function armRetry(paymentId: string, delayMs: number): void {
    clearRetry(paymentId);
    const timer = setTimeout(() => {
      retryTimers.delete(paymentId);
      timerDue.add(paymentId);
      start(paymentId);
    }, delayMs);
    timer.unref();
    retryTimers.set(paymentId, timer);
  }
  function clearRetry(paymentId: string): void {
    const timer = retryTimers.get(paymentId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(paymentId);
    timerDue.delete(paymentId);
  }

  function schedule(paymentId: string): Promise<void> {
    waiting.add(paymentId);
    const run = tail.then(() =>
      read(paymentId)
        .catch(async () => {
          // The database or the file store failed: leave it pending for the next sweep.
          args.log?.warn({}, 'slip check failed');
        })
        .finally(() => {
          waiting.delete(paymentId);
          if (again.delete(paymentId)) void schedule(paymentId);
        }),
    );
    tail = run;
    return run;
  }

  const hold = args.firstCallDelayMs ?? 0;
  /** Starts a read now, unless one is running (then it reads again after it) or the queue is full. */
  const start = (paymentId: string): void => {
    if (waiting.has(paymentId)) again.add(paymentId);
    else if (waiting.size < MAX_QUEUED) void schedule(paymentId);
  };

  return {
    wants: { ocr: Boolean(ocr), verify: Boolean(verifier) },
    enqueue(paymentId) {
      // A new upload starts its own cycle: the old picture's timer must not call for it.
      clearRetry(paymentId);
      if (waiting.has(paymentId)) again.add(paymentId);
      else if (hold > 0) {
        // A restart inside the hold loses the timer; the minute sweep then picks the row up (it
        // leaves a row alone while its hold runs). The timer checks `waiting` again when it fires.
        setTimeout(() => start(paymentId), hold).unref();
      } else start(paymentId);
    },
    async sweep(limit = SWEEP_LIMIT) {
      const ids = (
        await paymentsRepo.listPendingSlipChecks(
          ctx.db,
          limit,
          { ocr: Boolean(ocr), verify: Boolean(verifier) },
          // A row inside the first-call hold belongs to its timer.
          new Date(ctx.now().getTime() - hold),
        )
      ).filter((id) => !waiting.has(id) && !retryTimers.has(id));
      await Promise.all(ids.map(schedule));
      return ids.length;
    },
    async recheckBlocker(row, db = ctx.db) {
      if (
        row.slipVerifyAttempts >=
        staffCeiling(row.slipVerifyCode, row.slipVerifyAttempts - row.slipStaffCalls)
      )
        return 'attempts';
      const day = await currentBusinessDate(db, ctx.now());
      return (await paymentsRepo.slipVerifyCallsOn(db, day)) >= dailyCap ? 'cap' : null;
    },
    async recheck(paymentId, previous) {
      manual.set(paymentId, previous);
      try {
        await schedule(paymentId);
      } finally {
        manual.delete(paymentId);
      }
    },
    idle: async () => {
      // A read can queue another (a newer slip): wait until the tail stops moving.
      for (let seen = tail; ; seen = tail) {
        await seen;
        if (seen === tail) return;
      }
    },
  };
}

// One checker per process, installed by `server.ts` (the picture can arrive through the customer
// app or a LINE chat, and neither should have to carry the reader around). Without one - tests,
// or both SLIP_OCR=off and SLIP_VERIFIER=off - a slip simply gets no hint.
let installed: SlipChecker | null = null;

export const installSlipChecker = (checker: SlipChecker | null): void => {
  installed = checker;
};
export const activeSlipChecker = (): SlipChecker | null => installed;
