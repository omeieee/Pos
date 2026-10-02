/**
 * What the delivery details look like, as pure functions (no React, no I/O). The limits come from
 * `@sds/shared` (the same schemas the server checks); whether a building is one the shop delivers
 * to is decided against the saved list, and the server checks it again.
 *
 * Names are personal data (PDPA): nothing here logs or stores them.
 */
import {
  buildingNameSchema,
  type OrderDto,
  type RecipientDto,
  recipientNameSchema,
} from '@sds/shared';
import type { EntityState } from '../realtime/entity-store.ts';

/** The building list from the synced `delivery` setting, or null when it has not arrived. */
export function deliveryBuildings(settings: EntityState['settings']): readonly string[] | null {
  const entry = settings.get('delivery');
  return entry?.id === 'delivery' ? entry.data.buildings : null;
}

export interface DeliveryLabel {
  /** "B1 · Fah" */
  headline: string;
  /** The other details, when there are any. */
  note: string | null;
}

const headlineOf = (building: string, name: string) => `${building} · ${name}`;

/** The one label every screen shows for where an order goes; null when it carries no recipient. */
export function deliveryLabel(
  order: Pick<OrderDto, 'deliveryBuilding' | 'recipientName' | 'deliveryNote'>,
): DeliveryLabel | null {
  if (!order.deliveryBuilding || !order.recipientName) return null;
  return {
    headline: headlineOf(order.deliveryBuilding, order.recipientName),
    note: order.deliveryNote ? order.deliveryNote : null,
  };
}

export interface RecipientChip {
  recipient: RecipientDto;
  label: string;
  /** The saved other details, small. */
  hint: string | null;
}

export function chipLabel(recipient: RecipientDto): { label: string; hint: string | null } {
  return {
    label: headlineOf(recipient.building, recipient.recipientName),
    hint: recipient.deliveryNote ? recipient.deliveryNote : null,
  };
}

/** The chips in the order the server gave (most recent first). */
export function recipientChips(recipients: readonly RecipientDto[]): RecipientChip[] {
  return recipients.map((recipient) => ({ recipient, ...chipLabel(recipient) }));
}

/** Enough to place an order: a building from the list and a valid recipient name. */
export function deliveryReady(
  delivery: { building: string; name: string },
  buildings: readonly string[] | null,
): boolean {
  return (
    buildings !== null &&
    buildingNameSchema.safeParse(delivery.building).success &&
    buildings.includes(delivery.building.trim()) &&
    recipientNameSchema.safeParse(delivery.name).success
  );
}
