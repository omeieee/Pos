import { createHash } from 'node:crypto';
import { ordersRepo, paymentsRepo } from '@sds/db';
import {
  checkSlipRecipient,
  compareSlipAmount,
  extractSlipAmount,
  extractSlipRef,
  type SlipCheck,
  type SlipRecipientCheck,
  type SlipVerifyResult,
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
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** More pixels than this are not decoded: a phone screenshot is about 3 million. */
export const MAX_OCR_PIXELS = 16_000_000;
/** Beyond this many waiting, the rest is left to the sweep. */
const MAX_QUEUED = 50;
const SWEEP_LIMIT = 5;
/** Calls to Slip2Go per slip when it keeps failing (network, 429, 5xx, bank error), then `unchecked`. */
export const MAX_VERIFY_ATTEMPTS = 3;
/** The transfer may predate the order a little (the customer paid while the cart was open). */
const DATE_SLACK_MS = 10 * 60_000;
export const DEFAULT_DAILY_CAP = 100;

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
  | { kind: 'retry'; code: string | null; alert: null };

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
  /** Counts and ids only: never the text. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}): SlipChecker {
  const { ctx, slips, ocr, qr, verifier } = args;
  if (!ocr && !verifier) throw new Error('a slip checker needs the OCR or the verifier');
  const dailyCap = args.dailyCap ?? DEFAULT_DAILY_CAP;
  const waiting = new Set<string>();
  /** A new slip arrived for a payment that is being read: read it again when this one ends. */
  const again = new Set<string>();
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
    // Calls already made for this picture that never reached a verdict (a commit that failed
    // after the answer, or retries): at most MAX_VERIFY_ATTEMPTS in all, then unchecked.
    if (row.slipVerifyAttempts >= MAX_VERIFY_ATTEMPTS) return noCall();
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
    if ((await paymentsRepo.bumpSlipVerifyAttempts(ctx.db, row.id, row.slipImageHash)) === null) {
      return noCall();
    }
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
    const done = await evaluate(row, key, wantOcr, wantVerify);
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
        if (outcome.kind === 'retry') {
          // The attempt was counted before the call (`bumpSlipVerifyAttempts`).
          if (locked.slipVerifyAttempts >= MAX_VERIFY_ATTEMPTS) {
            patch.slipVerify = 'unchecked';
            patch.slipVerifyCode = outcome.code;
            patch.slipVerifiedAt = ctx.now();
          }
        } else {
          patch.slipVerify = outcome.verdict;
          patch.slipVerifyCode = outcome.code;
          patch.slipVerifyRef = outcome.ref;
          patch.slipVerifiedAt = ctx.now();
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
        });
        // It wrote the payment and emitted its events itself; the plain write below is for the rest.
        if (confirmed) return;
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

  return {
    wants: { ocr: Boolean(ocr), verify: Boolean(verifier) },
    enqueue(paymentId) {
      if (waiting.has(paymentId)) again.add(paymentId);
      else if (waiting.size < MAX_QUEUED) void schedule(paymentId);
    },
    async sweep(limit = SWEEP_LIMIT) {
      const ids = (
        await paymentsRepo.listPendingSlipChecks(ctx.db, limit, {
          ocr: Boolean(ocr),
          verify: Boolean(verifier),
        })
      ).filter((id) => !waiting.has(id));
      await Promise.all(ids.map(schedule));
      return ids.length;
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
