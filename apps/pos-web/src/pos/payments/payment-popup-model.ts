/**
 * The payment pop-up (D-42), as pure functions (no React, no I/O): the queue of alerts waiting to
 * be shown, and what one pop-up says. Nothing here decides a business rule: the server says an
 * order is paid or a slip needs review (`alert.payment`); this only lines the alerts up and picks
 * the fields to show.
 *
 * Privacy: the pop-up shows the LINE picture and name, the name given in the order, the building,
 * the dishes and the total. Never the phone number, the room or the note (owner, 2026-10-24).
 */
import { type ItemDto, itemPhotoPath, type OrderDto, type PaymentAlertKind } from '@sds/shared';

export interface PopupEntry {
  orderId: string;
  orderNo: string;
  kind: PaymentAlertKind;
}

/** More than this waiting at once is a runaway; the oldest after the shown one are dropped. */
export const MAX_QUEUED = 20;

const sameEntry = (a: PopupEntry, b: PopupEntry) => a.orderId === b.orderId && a.kind === b.kind;

/**
 * Adds an alert at the end. The same order and kind already waiting (or on screen: the first
 * entry) is not added twice. The input is not changed.
 */
export function enqueue(queue: readonly PopupEntry[], entry: PopupEntry): PopupEntry[] {
  if (queue.some((e) => sameEntry(e, entry))) return [...queue];
  const next = [...queue, entry];
  return next.length > MAX_QUEUED ? [next[0] as PopupEntry, ...next.slice(2)] : next;
}

/** The pop-up on screen is closed: the next one (if any) takes its place. */
export function dismissFirst(queue: readonly PopupEntry[]): PopupEntry[] {
  return queue.slice(1);
}

export interface PopupDish {
  id: string;
  qty: number;
  nameTh: string;
  nameEn: string | null;
  /** The path of the dish's photo on the API, or null (draw the placeholder). */
  photoPath: string | null;
}

export interface PopupContent {
  kind: PaymentAlertKind;
  orderId: string;
  orderNo: string;
  /** False while the order is not in the store yet: only the number is known. */
  loaded: boolean;
  line: { displayName: string | null; pictureUrl: string | null } | null;
  recipientName: string | null;
  deliveryBuilding: string | null;
  dishes: PopupDish[];
  /** Null for a role that does not work with money (the kitchen). */
  totalSatang: number | null;
}

const blank = (value: string | null | undefined) => {
  const text = value?.trim();
  return text ? text : null;
};

/**
 * What one pop-up says. `items` is the menu of the store, for the photos. `showTotal` is false
 * for a role that never sees money.
 */
export function buildPopupContent(
  entry: PopupEntry,
  order: OrderDto | undefined,
  items: ReadonlyMap<string, Pick<ItemDto, 'id' | 'photoVersion' | 'photoUrl'>>,
  showTotal: boolean,
): PopupContent {
  if (!order) {
    return {
      kind: entry.kind,
      orderId: entry.orderId,
      orderNo: entry.orderNo,
      loaded: false,
      line: null,
      recipientName: null,
      deliveryBuilding: null,
      dishes: [],
      totalSatang: null,
    };
  }
  const displayName = blank(order.line?.displayName);
  const pictureUrl = blank(order.line?.pictureUrl);
  return {
    kind: entry.kind,
    orderId: entry.orderId,
    orderNo: order.orderNo,
    loaded: true,
    line: displayName || pictureUrl ? { displayName, pictureUrl } : null,
    recipientName: blank(order.recipientName),
    deliveryBuilding: blank(order.deliveryBuilding),
    dishes: order.items.map((item) => {
      const menuItem = items.get(item.menuItemId);
      return {
        id: item.id,
        qty: item.qty,
        nameTh: item.nameTh,
        nameEn: item.nameEn,
        photoPath: menuItem ? itemPhotoPath(menuItem) : null,
      };
    }),
    totalSatang: showTotal ? order.totalSatang : null,
  };
}
