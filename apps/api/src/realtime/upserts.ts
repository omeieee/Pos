/**
 * Live events for synced rows a writer changed without holding their DTOs (BE-02): a retention
 * batch, an erasure, a customer's counters or member profile, a slip flag. Every such write bumps
 * the row's rev (the sync trigger), and a device that stays connected only hears of it through an
 * event: its catch-up runs on reconnect only. So a writer that changes these rows publishes them.
 *
 * The rows are read back as they are now, through the feed's allow-lists (`syncRepo.readRowsByIds`)
 * and the same DTO mappers the catch-up uses, so an event carries exactly what a catch-up would:
 * an erased name goes out erased, never as it was. Inside a transaction, pass its `emit` (the
 * events go out after commit, none on rollback); after a batch that committed on its own, pass
 * `events.publish`.
 */
import { type Db, syncRepo } from '@sds/db';
import { toCustomerDto } from '../customers/dto.ts';
import type { AppEvent } from '../events.ts';
import { toOrderDto } from '../orders/dto.ts';
import { toPaymentDto } from '../payments/dto.ts';
import type { Emit } from '../tx.ts';

export interface ChangedRows {
  orders?: Iterable<string>;
  payments?: Iterable<string>;
  customers?: Iterable<string>;
}

function eventOf(entry: syncRepo.SyncEntry): AppEvent | null {
  switch (entry.kind) {
    case 'order':
      return {
        type: 'order.upserted',
        id: entry.order.id,
        rev: entry.order.rev,
        data: toOrderDto(entry.order, entry.items),
      };
    case 'payment':
      return {
        type: 'payment.upserted',
        id: entry.payment.id,
        rev: entry.payment.rev,
        data: toPaymentDto(entry.payment),
      };
    case 'customer':
      return {
        type: 'customer.upserted',
        id: entry.customer.id,
        rev: entry.customer.rev,
        data: toCustomerDto(entry.customer),
      };
    default:
      return null;
  }
}

/**
 * Emits one `*.upserted` event per changed row that still exists, oldest rev first within each
 * read of up to `syncRepo.ROWS_BY_IDS_MAX` ids per family. Returns how many it emitted.
 */
export async function emitRowUpserts(db: Db, emit: Emit, changed: ChangedRows): Promise<number> {
  const orders = [...new Set(changed.orders ?? [])];
  const payments = [...new Set(changed.payments ?? [])];
  const customers = [...new Set(changed.customers ?? [])];
  const step = syncRepo.ROWS_BY_IDS_MAX;
  let emitted = 0;
  const longest = Math.max(orders.length, payments.length, customers.length);
  for (let i = 0; i < longest; i += step) {
    const entries = await syncRepo.readRowsByIds(db, {
      orders: orders.slice(i, i + step),
      payments: payments.slice(i, i + step),
      customers: customers.slice(i, i + step),
    });
    for (const entry of entries) {
      const event = eventOf(entry);
      if (!event) continue;
      emit(event);
      emitted += 1;
    }
  }
  return emitted;
}
