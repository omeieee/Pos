/** The words for the outbox: why an order could not be saved, and why the server refused an entry. */
import { codeText, type Translate } from '../api/errors.ts';
import type { SaveError } from './cart-store.ts';
import {
  ERROR_NOT_UNDERSTOOD,
  ERROR_PARENT_MISSING,
  ERROR_QR_AMOUNT,
  ERROR_QR_TARGET,
  ERROR_TENDER_BELOW,
  MAX_QUEUE,
  type QueueItem,
} from './outbox-model.ts';

export function saveErrorText(tr: Translate, reason: SaveError): string {
  switch (reason) {
    case 'storage':
      return tr('outbox.error.storage');
    case 'full':
      return tr('outbox.error.full', { max: MAX_QUEUE });
    case 'noSession':
      return tr('outbox.error.noSession');
    case 'orderGone':
      return tr('outbox.error.orderGone');
    case 'busy':
      return tr('outbox.error.busy');
  }
}

/** What went wrong with an entry that needs attention, in words for the cashier. */
export function entryErrorText(tr: Translate, error: string | null): string {
  if (error === ERROR_NOT_UNDERSTOOD) return tr('outbox.error.unreadable');
  if (error === ERROR_PARENT_MISSING) return tr('outbox.error.orderMissing');
  if (error === ERROR_TENDER_BELOW) return tr('outbox.error.tenderBelow');
  if (error === ERROR_QR_AMOUNT) return tr('outbox.error.qrAmount');
  if (error === ERROR_QR_TARGET) return tr('outbox.error.qrId');
  if (error === 'ORDER_ALREADY_PAID') return tr('outbox.error.alreadyPaid');
  if (error === 'PAYMENT_ALREADY_OPEN') return tr('outbox.error.alreadyOpen');
  return tr('outbox.refused', { reason: codeText(tr, error ?? 'UNKNOWN') });
}

/** The state of an entry as a short label: always shown with an icon, never colour alone. */
export function stateKey(item: Pick<QueueItem, 'state' | 'stuck'>) {
  if (item.state === 'attention') return 'outbox.state.attention' as const;
  if (item.state === 'blocked') return 'outbox.state.blocked' as const;
  return item.stuck ? ('outbox.state.stuck' as const) : ('outbox.state.waiting' as const);
}
