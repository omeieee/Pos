/**
 * Orders board: picks the layout for the screen size.
 */
import { useState } from 'react';
import { useLayout } from '../../design/layout.ts';
import { useEntities, useNow } from '../../ui/hooks.ts';
import { MonthOverview } from './MonthOverview.tsx';
import { OrdersPhone } from './OrdersPhone.tsx';
import { OrdersTable } from './OrdersTable.tsx';
import { currentBusinessDay, ordersForDay } from './order-board.ts';
import { useLoadOrders } from './use-load-orders.ts';

/**
 * Today's orders (design "Orders"): on a laptop or iPad a table of the day with a search box, a
 * payment filter and the chosen order's detail beside it; on an iPhone a list of cards with the
 * day's receipts on top. The orders come from the entity store (realtime keeps them live); opening
 * the page also fetches today's list once, so a fresh device sees them without waiting for the
 * first sync. Choosing a row only shows its detail: the order page (`#/orders/<id>`), where the
 * moves and the payment are, opens from the detail's main button or a phone card.
 */
export function OrdersScreen() {
  const state = useEntities();
  const now = useNow(30_000);
  const layout = useLayout();
  // null: today. A date: that business day, so any past order can be found and opened.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [monthOpen, setMonthOpen] = useState(false);
  const today = currentBusinessDay(state.settings, now);
  const day = pickedDay ?? today;
  const { load, retry } = useLoadOrders(pickedDay ?? undefined);

  const todays = ordersForDay(state.orders.values(), day);
  const dayPick = { day, today, onPickDay: setPickedDay, onOpenMonth: () => setMonthOpen(true) };

  if (monthOpen) {
    return (
      <MonthOverview
        today={today}
        day={day}
        onPick={setPickedDay}
        onClose={() => setMonthOpen(false)}
      />
    );
  }

  return layout === 'phone' ? (
    <OrdersPhone key={day} todays={todays} now={now} load={load} retry={retry} {...dayPick} />
  ) : (
    <OrdersTable
      key={day}
      layout={layout}
      todays={todays}
      now={now}
      load={load}
      retry={retry}
      {...dayPick}
    />
  );
}
