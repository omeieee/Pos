import { createHash } from 'node:crypto';
import { paymentsRepo } from '@sds/db';
import {
  checkSlipRecipient,
  compareSlipAmount,
  extractSlipAmount,
  extractSlipRef,
  type SlipCheck,
  type SlipRecipientCheck,
} from '@sds/shared';
import { toPaymentDto } from '../payments/dto.ts';
import { currentBankAccountNumber, currentPromptpayId } from '../settings/service.ts';
import { type CoreContext, withTransaction } from '../tx.ts';
import { imageSize } from './image.ts';
import type { SlipOcr } from './ocr.ts';
import type { SlipQrReader } from './qr.ts';
import type { SlipStore } from './store.ts';

/**
 * The automatic reading of a slip (D-26). It looks for the amount on the picture and compares it
 * with what the payment charges. The answer is only a hint on the payment (`slip_check`): it never
 * confirms or rejects money (CLAUDE.md rule 2), never fails an upload, and keeps only the amount
 * and the verdict, the word `match`/`mismatch`/`unknown` for whether the receiver on the slip looks
 * like the shop's PromptPay ID or receiving account (read from settings now, never kept), plus hashes of the bank reference and of the reference inside the slip's small
 * QR (for the duplicate hint; never the references themselves). The OCR text, which holds names and account numbers, is dropped at once.
 */
export interface SlipChecker {
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

export function createSlipChecker(args: {
  ctx: CoreContext;
  slips: SlipStore;
  ocr: SlipOcr;
  /** Reads the slip's small QR (D-26); without one, only the printed reference is used. */
  qr?: SlipQrReader;
  /** Counts and ids only: never the text. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}): SlipChecker {
  const { ctx, slips, ocr, qr } = args;
  const waiting = new Set<string>();
  /** A new slip arrived for a payment that is being read: read it again when this one ends. */
  const again = new Set<string>();
  let tail: Promise<void> = Promise.resolve();

  async function evaluate(
    key: string,
    expected: number,
  ): Promise<{
    check: Exclude<SlipCheck, 'pending'>;
    amount: number | null;
    refHash: string | null;
    qrHash: string | null;
    recipient: SlipRecipientCheck | null;
  }> {
    const bytes = await slips.get(key);
    const size = bytes ? imageSize(bytes) : null;
    if (!bytes || !size || size.width * size.height > MAX_OCR_PIXELS) {
      return { check: 'unreadable', amount: null, refHash: null, qrHash: null, recipient: null };
    }
    // The small QR first: it is cheap, it works on screenshots and re-photos, and it still counts
    // when the text cannot be read. A failure here only means "no QR key"; it never fails the check.
    let qrHash: string | null = null;
    if (qr) {
      try {
        const found = await qr.read(bytes);
        if (found) qrHash = sha256(`${found.sendingBank}:${found.transRef}`);
      } catch (error) {
        args.log?.warn({ reason: error instanceof Error ? error.message : 'QR_FAILED' }, 'slip QR');
      }
    }
    let text: string;
    try {
      text = await ocr.read(bytes);
    } catch (error) {
      // The class of the failure only: the message of a reader could echo what it read.
      args.log?.warn({ reason: error instanceof Error ? error.message : 'OCR_FAILED' }, 'slip OCR');
      return { check: 'unreadable', amount: null, refHash: null, qrHash, recipient: null };
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
    return { check: compareSlipAmount(amount, expected), amount, refHash, qrHash, recipient };
  }

  async function read(paymentId: string): Promise<void> {
    const row = await paymentsRepo.findPaymentById(ctx.db, paymentId);
    if (row?.slipCheck !== 'pending' || !row.slipImageKey) return;
    const key = row.slipImageKey;
    const { check, amount, refHash, qrHash, recipient } = await evaluate(key, row.amountSatang);
    await withTransaction(ctx, async (tx, emit) => {
      const locked = await paymentsRepo.lockPaymentById(tx, paymentId);
      // A newer slip, or a purge, came in while the picture was being read: this answer is stale.
      if (locked?.slipImageKey !== key || locked.slipCheck !== 'pending') return;
      const updated = await paymentsRepo.updatePaymentIfVersion(tx, locked.id, locked.version, {
        slipCheck: check,
        slipAmountSatang: amount,
        slipRefHash: refHash,
        slipQrHash: qrHash,
        slipRecipientCheck: recipient,
      });
      // The payment's status is never touched. Devices get the new rev and ask for the hint.
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
    enqueue(paymentId) {
      if (waiting.has(paymentId)) again.add(paymentId);
      else if (waiting.size < MAX_QUEUED) void schedule(paymentId);
    },
    async sweep(limit = SWEEP_LIMIT) {
      const ids = (await paymentsRepo.listPendingSlipChecks(ctx.db, limit)).filter(
        (id) => !waiting.has(id),
      );
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
// or SLIP_OCR=off - a slip simply gets no hint.
let installed: SlipChecker | null = null;

export const installSlipChecker = (checker: SlipChecker | null): void => {
  installed = checker;
};
export const activeSlipChecker = (): SlipChecker | null => installed;
