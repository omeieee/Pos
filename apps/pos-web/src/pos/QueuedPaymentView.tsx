import type { QueuedPayment } from './outbox-model.ts';
import { QueuedCash } from './QueuedCash.tsx';
import { QueuedPromptpay } from './QueuedPromptpay.tsx';

/** A payment taken offline and waiting to be sent, by method. */
export function QueuedPaymentView({ item }: { item: QueuedPayment }) {
  return item.method === 'cash' ? <QueuedCash item={item} /> : <QueuedPromptpay item={item} />;
}
