import { useState } from 'react';
import { useAuthState, useEntities, useNow, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { KitchenTicket, ReadyRow } from './KitchenTicket.tsx';
import { kitchenQueue } from './kitchen-model.ts';
import { SoundControl } from './SoundControl.tsx';
import { useKitchenDisplay } from './use-kitchen-display.ts';
import { useLoadOrders } from './use-load-orders.ts';

/**
 * The kitchen view (`#/kitchen`): the orders to make as big-type tickets, oldest first, with a
 * collapsed list of the ones that are ready and waiting for hand-over. Made for an iPhone on the
 * kitchen wall in portrait, and just as usable on an iPad or a laptop (the tickets form a grid).
 *
 * The orders come from the entity store, so a new order appears by itself (realtime) and a
 * finished one leaves; opening the view also fetches today's list once. It shows no price, no
 * total and no payment action. While it is open the screen stays awake and the session stays
 * signed in (`useKitchenDisplay`), and the sound switch lives here (iOS needs a tap to unlock audio).
 */
export function KitchenScreen() {
  const tr = useT();
  const role = useAuthState().session?.staff.role;
  const state = useEntities();
  // Minutes waiting are whole minutes: re-read the clock twice a minute.
  const now = useNow(30_000);
  const { load, retry } = useLoadOrders();
  const [readyOpen, setReadyOpen] = useState(false);
  useKitchenDisplay();

  if (!role) return null;
  const queue = kitchenQueue(state.orders.values());

  return (
    <section className="kitchen" aria-labelledby="kitchen-title">
      <header className="kitchen__head">
        <div className="kitchen__title">
          <h1 id="kitchen-title" className="board__title">
            {tr('kitchen.title')}
          </h1>
          <span className="board__count kitchen__count">
            {tr('kitchen.toMakeCount', { count: queue.toMake.length })}
          </span>
        </div>
        <SoundControl />
      </header>

      {load === 'error' ? (
        <div className="error board__notice" role="alert">
          <span>{tr('orders.loadFailed')}</span>
          <button type="button" className="btn" onClick={retry}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}

      {queue.toMake.length === 0 ? (
        <p className="muted board__empty" role={load === 'loading' ? 'status' : undefined}>
          {load === 'loading' ? tr('kitchen.loading') : tr('kitchen.empty')}
        </p>
      ) : (
        <ol className="ktickets" aria-label={tr('kitchen.toMake')}>
          {queue.toMake.map((order) => (
            <KitchenTicket key={order.id} order={order} role={role} now={now} />
          ))}
        </ol>
      )}

      <section className="kready" aria-labelledby="kready-toggle">
        <h2 className="kready__heading">
          <button
            id="kready-toggle"
            type="button"
            className="btn btn-soft btn-block kready__toggle"
            aria-expanded={readyOpen}
            aria-controls="kready-list"
            onClick={() => setReadyOpen((open) => !open)}
          >
            <Icon name="check-circle" />
            <span>{tr('kitchen.ready.toggle', { count: queue.ready.length })}</span>
          </button>
        </h2>
        {readyOpen ? (
          <div id="kready-list">
            {queue.ready.length === 0 ? (
              <p className="muted small">{tr('kitchen.ready.empty')}</p>
            ) : (
              <ul className="kready__list">
                {queue.ready.map((order) => (
                  <ReadyRow key={order.id} order={order} now={now} />
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </section>
  );
}
