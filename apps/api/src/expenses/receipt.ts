/**
 * Expense receipt photos (D-36). The picture is prepared (decoded, shrunk, EXIF removed) and stored
 * under a random key in a store of its own (`receipts/` on R2), and the key is written to
 * `expenses.receipt_image_key` through the same version rules as every other expense change. A
 * receipt is a tax record: it is kept 5 years and no job deletes it; only a person removes it, on
 * purpose, and that is audited. Rows are never deleted, so a voided expense keeps its photo.
 */
import { createHash } from 'node:crypto';
import { expensesRepo, insertAudit } from '@sds/db';
import type { ExpenseDto } from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, conflict, notFound, versionConflict } from '../errors.ts';
import { sniffSlip } from '../slips/image.ts';
import { newSlipKey, type SlipStore } from '../slips/store.ts';
import { type Emit, withTransaction } from '../tx.ts';
import { toExpenseDto } from './dto.ts';
import { MAX_RECEIPT_BYTES, prepareReceiptImage, type ReceiptImageError } from './receipt-image.ts';

const actorOf = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});

const publish = (emit: Emit, row: expensesRepo.ExpenseRow) =>
  emit({ type: 'expense.upserted', id: row.id, rev: row.rev, data: toExpenseDto(row) });

const voided = () => conflict('EXPENSE_VOIDED', 'This expense was voided and cannot be changed');
const noReceipt = () => new ApiError(404, 'RECEIPT_NOT_FOUND', 'This expense has no receipt photo');

const REFUSALS: Record<ReceiptImageError['code'], ApiError> = {
  unsupported: new ApiError(415, 'RECEIPT_TYPE_UNSUPPORTED', 'Send a JPEG or PNG picture'),
  too_large: new ApiError(413, 'RECEIPT_TOO_LARGE', 'This picture has too many pixels'),
  undecodable: new ApiError(422, 'RECEIPT_UNREADABLE', 'This picture could not be read'),
};

/** A leftover file is not worth failing the answer for: try twice, then leave it. */
async function removeFile(store: SlipStore, key: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await store.delete(key);
      return;
    } catch {
      // try again, then give up
    }
  }
}

export interface AttachReceiptInput {
  /** The picture as the client sent it. */
  bytes: Buffer;
  /** The Idempotency-Key header (a UUID). */
  requestId: string;
  expectedVersion: number;
}

export interface AttachedReceipt {
  dto: ExpenseDto;
  /** True when the request id was seen before: nothing was written. */
  replay: boolean;
}

/**
 * Sets (or replaces) the receipt photo. A repeat of the same Idempotency-Key with the same picture
 * answers with the expense as it is, whatever its version has become since; the same key with
 * another picture is 409. The new file is written first and removed again if the commit fails;
 * a replaced file is removed after the commit.
 */
export async function attachReceipt(
  ctx: AuthContext,
  store: SlipStore,
  actor: Principal,
  id: string,
  input: AttachReceiptInput,
  meta: RequestMeta,
): Promise<AttachedReceipt> {
  if (input.bytes.length > MAX_RECEIPT_BYTES) {
    throw new ApiError(413, 'RECEIPT_TOO_LARGE', 'This picture is too big');
  }
  if (sniffSlip(input.bytes) === null) throw REFUSALS.unsupported;
  const hash = createHash('sha256').update(input.bytes).digest('hex');

  const existing = await expensesRepo.findExpenseById(ctx.db, id);
  if (!existing) throw notFound('Expense');
  const replay = replayOf(existing, input.requestId, hash);
  if (replay) return replay;

  let prepared: Awaited<ReturnType<typeof prepareReceiptImage>>;
  try {
    prepared = await prepareReceiptImage(input.bytes);
  } catch (error) {
    const refusal = REFUSALS[(error as ReceiptImageError).code];
    throw refusal ?? error;
  }
  const key = newSlipKey();
  await store.put(key, prepared.bytes);

  let replaced: string | null = null;
  let result: AttachedReceipt;
  try {
    result = await withTransaction(ctx, async (tx, emit) => {
      const row = await expensesRepo.lockExpense(tx, id);
      if (!row) throw notFound('Expense');
      // A concurrent request with the same key may have won while the picture was prepared.
      const again = replayOf(row, input.requestId, hash);
      if (again) return again;
      if (row.version !== input.expectedVersion) throw versionConflict(row.version);
      if (row.voidedAt) throw voided();
      const updated = await expensesRepo.updateExpenseIfVersion(tx, id, row.version, {
        receiptImageKey: key,
        receiptRequestId: input.requestId,
        receiptRequestHash: hash,
      });
      if (!updated) throw versionConflict(row.version);
      await insertAudit(tx, {
        ...actorOf(actor, meta),
        action: 'expense.receipt.attach',
        entity: 'expenses',
        entityId: id,
        // Never the key or the picture: only that there is one now and whether it replaced one.
        before: { hasReceipt: row.receiptImageKey !== null },
        after: { hasReceipt: true },
      });
      publish(emit, updated);
      replaced = row.receiptImageKey;
      return { dto: toExpenseDto(updated), replay: false };
    });
  } catch (error) {
    await store.delete(key).catch(() => undefined);
    throw error;
  }
  if (result.replay) {
    await store.delete(key).catch(() => undefined); // the winner's file is the one in use
  } else if (replaced) {
    await removeFile(store, replaced);
  }
  return result;
}

function replayOf(
  row: expensesRepo.ExpenseRow,
  requestId: string,
  hash: string,
): AttachedReceipt | null {
  if (row.receiptRequestId === null || row.receiptRequestId !== requestId) return null;
  if (row.receiptRequestHash !== hash) {
    throw conflict(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for another picture. Make a new request id',
    );
  }
  return { dto: toExpenseDto(row), replay: true };
}

/** Takes the photo off the expense (the row stays) and then deletes the file. */
export async function removeReceipt(
  ctx: AuthContext,
  store: SlipStore,
  actor: Principal,
  id: string,
  expectedVersion: number,
  meta: RequestMeta,
): Promise<ExpenseDto> {
  let oldKey: string | null = null;
  const dto = await withTransaction(ctx, async (tx, emit) => {
    const row = await expensesRepo.lockExpense(tx, id);
    if (!row) throw notFound('Expense');
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    if (row.voidedAt) throw voided();
    if (row.receiptImageKey === null) throw noReceipt();
    const updated = await expensesRepo.updateExpenseIfVersion(tx, id, row.version, {
      receiptImageKey: null,
      receiptRequestId: null,
      receiptRequestHash: null,
    });
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'expense.receipt.delete',
      entity: 'expenses',
      entityId: id,
      before: { hasReceipt: true },
      after: { hasReceipt: false },
    });
    publish(emit, updated);
    oldKey = row.receiptImageKey;
    return toExpenseDto(updated);
  });
  // After the commit. A file that will not go is left behind (receipts have no orphan sweep).
  if (oldKey) await removeFile(store, oldKey);
  return dto;
}

/** The photo, for owner and manager. Every look writes an audit row (who, which expense; no key). */
export async function readReceipt(
  ctx: AuthContext,
  store: SlipStore,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<{ bytes: Buffer; contentType: 'image/jpeg' | 'image/png' }> {
  const row = await expensesRepo.findExpenseById(ctx.db, id);
  if (!row) throw notFound('Expense');
  if (!row.receiptImageKey) throw noReceipt();
  const bytes = await store.get(row.receiptImageKey);
  const type = bytes ? sniffSlip(bytes) : null;
  if (!bytes || (type !== 'image/jpeg' && type !== 'image/png')) throw noReceipt();
  await insertAudit(ctx.db, {
    ...actorOf(actor, meta),
    action: 'expense.receipt.view',
    entity: 'expenses',
    entityId: id,
  });
  return { bytes, contentType: type };
}
