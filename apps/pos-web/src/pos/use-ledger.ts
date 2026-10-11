import { useServices, useStoreState } from '../ui/hooks.ts';
import type { OrderLedger } from './payment-store.ts';

/** What the server last said about this order's refunds, net paid and amount still due. */
export function useLedger(orderId: string): OrderLedger | undefined {
  const { payments } = useServices();
  return useStoreState(payments).ledger[orderId];
}
