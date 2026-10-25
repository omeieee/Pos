/**
 * Sends an order to the kitchen (BE-01): called inside the transaction that moves the order to
 * `preparing` (a counter order at creation, an accept, a pay-first order that became paid). While
 * the owner's printing switch is on, the order's one kitchen job is written in that same
 * transaction, so a ticket can no longer be lost between the commit and work started after it (a
 * restart, a deploy). `order.sent_to_kitchen` is still published after the commit for the devices.
 *
 * The job is written in a savepoint: if the queue cannot be written, only the savepoint is undone,
 * the order still commits (printing never breaks an order) and staff get `print.enqueue_failed`
 * (ids and the order number only). A second call for the same order adds nothing.
 */
import { type Db, printRepo } from '@sds/db';
import { securityAlert } from '../auth/context.ts';
import { currentPrintingEnabled } from '../settings/service.ts';
import type { Emit } from '../tx.ts';

export async function sendToKitchen(
  tx: Db,
  emit: Emit,
  order: { id: string; orderNo: string },
  now: Date,
): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      if (!(await currentPrintingEnabled(savepoint))) return;
      await printRepo.insertJob(savepoint, { orderId: order.id, kind: 'kitchen', seq: 0, now });
    });
  } catch {
    emit(
      securityAlert({ now: () => now }, 'print.enqueue_failed', 'warn', {
        subject: { orderId: order.id },
        orderNo: order.orderNo,
      }),
    );
  }
  emit({ type: 'order.sent_to_kitchen', orderId: order.id });
}
