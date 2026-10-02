import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../ui/hooks.ts';

export type OrdersLoad = 'loading' | 'ok' | 'error';

/**
 * Fetches the orders of today once when a screen opens (and again on `retry`), so a fresh device
 * shows them without waiting for the first sync, and puts them into the entity store. Realtime
 * keeps them live after that. A failure leaves whatever the store already has.
 */
export function useLoadOrders(): { load: OrdersLoad; retry: () => void } {
  const { api, entities } = useServices();
  const [load, setLoad] = useState<OrdersLoad>('loading');
  const [attempt, setAttempt] = useState(0);

  // `attempt` re-runs the load when the person taps "try again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    setLoad('loading');
    api.orders.list().then(
      (listed) => {
        if (!live) return;
        entities.applyMany(
          listed.orders.map((order) => ({
            type: 'order.upserted' as const,
            id: order.id,
            rev: order.rev,
            data: order,
          })),
        );
        setLoad('ok');
      },
      () => {
        if (live) setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, entities, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, retry };
}
