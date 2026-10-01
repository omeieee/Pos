/**
 * From what the services publish (events) and what the sync reader returns (rows) to the frames
 * devices receive, and who may receive each (02 §5).
 *
 * Every frame is rebuilt here from named fields and parsed through the shared frame schema, which
 * drops unknown keys: whatever a producer put into an event, a device only gets the DTO shape. A
 * frame that does not parse is dropped (and reported by type and id, never by content), and an
 * event type with no case below is ignored, so a new kind of event reaches nobody until someone
 * chooses its shape and its audience here.
 */
import type { syncRepo } from '@sds/db';
import {
  type CustomerDto,
  customerDtoSchema,
  customerUpsertedFrameSchema,
  type FrameType,
  hasPermission,
  menuUpsertedFrameSchema,
  newOrderAlertFrameSchema,
  orderUpsertedFrameSchema,
  type Permission,
  paymentUpsertedFrameSchema,
  type RealtimeFrame,
  type StaffRole,
  type SyncChange,
  settingsUpdatedFrameSchema,
} from '@sds/shared';
import type { z } from 'zod';
import type { AppEvent } from '../events.ts';
import { toCategory, toGroup, toItem, toOption } from '../menu/service.ts';
import { toOrderDto } from '../orders/dto.ts';
import { toPaymentDto } from '../payments/dto.ts';
import { toDto as toGovCopayDto } from '../settings/service.ts';

// ---------- Who receives what ----------

/**
 * The permission that opens each kind of frame; `null` means any signed-in staff. Each mirrors the
 * REST route that reads the same data, so the feed shows a role nothing the REST API would refuse
 * it. A new frame type cannot be added to `FRAME_TYPES` without a line here (it is a Record).
 */
export const FRAME_PERMISSION: Record<FrameType, Permission | null> = {
  // GET /v1/orders is open to every role: the kitchen works from the queue.
  'order.upserted': null,
  // GET /v1/orders/:id/payments needs payment.record (the kitchen never sees amounts or methods).
  'payment.upserted': 'payment.record',
  // The staff menu lists need menu.availability, which every role has (the "sold out" toggle).
  'menu.upserted': 'menu.availability',
  // GET /v1/settings/* needs settings.view (not the kitchen). The PromptPay frame is masked.
  'settings.updated': 'settings.view',
  // Customer data is personal data: customer.view only.
  'customer.upserted': 'customer.view',
  // The kitchen needs the sound as much as the till.
  'alert.new_order': null,
};

export function mayReceive(role: StaffRole, frame: { type: FrameType }): boolean {
  const needed = FRAME_PERMISSION[frame.type];
  return needed === null || hasPermission(role, needed);
}

/** The families of rows a role may read in a catch-up; the same rules as `mayReceive`. */
export function familiesFor(role: StaffRole): syncRepo.SyncInclude {
  const may = (type: FrameType) => mayReceive(role, { type });
  return {
    orders: may('order.upserted'),
    payments: may('payment.upserted'),
    menu: may('menu.upserted'),
    settings: may('settings.updated'),
    customers: may('customer.upserted'),
  };
}

// ---------- Events to frames ----------

export type FrameFromEvent =
  | { kind: 'frame'; frame: RealtimeFrame }
  /** An event that is not for devices (a security alert, a session ending). */
  | { kind: 'ignored' }
  /** A device event whose data did not fit its schema: dropped. Names the type only. */
  | { kind: 'invalid'; type: FrameType };

function build<S extends z.ZodType<RealtimeFrame>>(
  schema: S,
  type: FrameType,
  candidate: unknown,
): FrameFromEvent {
  const parsed = schema.safeParse(candidate);
  return parsed.success ? { kind: 'frame', frame: parsed.data } : { kind: 'invalid', type };
}

export function frameFromEvent(event: AppEvent): FrameFromEvent {
  switch (event.type) {
    case 'order.upserted':
      return build(orderUpsertedFrameSchema, event.type, {
        type: event.type,
        id: event.id,
        rev: event.rev,
        data: event.data,
      });
    case 'payment.upserted':
      return build(paymentUpsertedFrameSchema, event.type, {
        type: event.type,
        id: event.id,
        rev: event.rev,
        data: event.data,
      });
    case 'menu.upserted':
      return build(menuUpsertedFrameSchema, event.type, {
        type: event.type,
        kind: event.kind,
        id: event.id,
        rev: event.rev,
        data: event.data,
      });
    case 'settings.updated':
      return build(settingsUpdatedFrameSchema, event.type, {
        type: event.type,
        id: event.key,
        rev: event.rev,
        version: event.version,
        data: event.data,
      });
    case 'customer.upserted':
      return build(customerUpsertedFrameSchema, event.type, {
        type: event.type,
        id: event.id,
        rev: event.rev,
        data: event.data,
      });
    case 'alert.new_order':
      return build(newOrderAlertFrameSchema, event.type, {
        type: event.type,
        id: event.orderId,
        data: {
          orderNo: event.orderNo,
          channel: event.channel,
          status: event.status,
          createdOnDeviceId: event.createdOnDeviceId,
        },
      });
    case 'alert.security':
    case 'session.ended':
      return { kind: 'ignored' };
    default: {
      const unhandled: never = event;
      void unhandled;
      return { kind: 'ignored' };
    }
  }
}

// ---------- Sync rows to frames ----------

export function toCustomerDto(row: syncRepo.SyncCustomerRow): CustomerDto {
  return customerDtoSchema.parse({
    id: row.id,
    displayName: row.displayName,
    nickname: row.nickname,
    roomNo: row.roomNo,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
    orderCount: row.orderCount,
    totalSpentSatang: row.totalSpentSatang,
    anonymized: row.anonymizedAt !== null,
    version: row.version,
    rev: row.rev,
  });
}

/**
 * The frame for one row of a catch-up page, built by the same mappers the live events use, so a
 * device that catches up and a device that listened see the same thing. Null when the row does not
 * fit its schema (a malformed row must not stop the page: the caller reports its kind and id).
 */
export function frameFromEntry(entry: syncRepo.SyncEntry): SyncChange | null {
  try {
    switch (entry.kind) {
      case 'order':
        return orderUpsertedFrameSchema.parse({
          type: 'order.upserted',
          id: entry.order.id,
          rev: entry.order.rev,
          data: toOrderDto(entry.order, entry.items),
        });
      case 'payment':
        return paymentUpsertedFrameSchema.parse({
          type: 'payment.upserted',
          id: entry.payment.id,
          rev: entry.payment.rev,
          data: toPaymentDto(entry.payment),
        });
      case 'category':
        return menuUpsertedFrameSchema.parse({
          type: 'menu.upserted',
          kind: 'category',
          id: entry.category.id,
          rev: entry.category.rev,
          data: toCategory(entry.category),
        });
      case 'item':
        return menuUpsertedFrameSchema.parse({
          type: 'menu.upserted',
          kind: 'item',
          id: entry.item.id,
          rev: entry.item.rev,
          data: toItem(entry.item, {
            channelPrices: new Map([[entry.item.id, entry.channelPrices]]),
            groupIds: new Map([[entry.item.id, entry.groupIds]]),
          }),
        });
      case 'group':
        return menuUpsertedFrameSchema.parse({
          type: 'menu.upserted',
          kind: 'group',
          id: entry.group.id,
          rev: entry.group.rev,
          data: toGroup(entry.group, entry.options),
        });
      case 'option':
        return menuUpsertedFrameSchema.parse({
          type: 'menu.upserted',
          kind: 'option',
          id: entry.option.id,
          rev: entry.option.rev,
          data: toOption(entry.option),
        });
      case 'customer':
        return customerUpsertedFrameSchema.parse({
          type: 'customer.upserted',
          id: entry.customer.id,
          rev: entry.customer.rev,
          data: toCustomerDto(entry.customer),
        });
      case 'setting':
        return settingsUpdatedFrameSchema.parse({
          type: 'settings.updated',
          id: entry.setting.key,
          rev: entry.setting.rev,
          version: entry.setting.version,
          data: entry.setting.value,
        });
      case 'gov_copay':
        return settingsUpdatedFrameSchema.parse({
          type: 'settings.updated',
          id: 'gov_copay',
          rev: entry.scheme.rev,
          version: entry.scheme.version,
          data: toGovCopayDto(entry.scheme),
        });
    }
  } catch {
    return null;
  }
}
