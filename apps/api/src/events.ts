/**
 * In-process event bus (D-04, D-16). Services collect events inside a transaction and publish
 * them only after it commits, so a subscriber never sees a change that was rolled back.
 * Events carry ids and facts, never secrets.
 */
import type { OrderChannel, OrderDto, OrderStatus, PaymentDto } from '@sds/shared';

/** A security-relevant fact the owner should hear about (CLAUDE.md rule 9). Delivery comes in P8 (ntfy). */
export interface SecurityAlertEvent {
  type: 'alert.security';
  /** e.g. `device.registered`, `staff.pin_locked`, `owner.login_locked`, `owner.recovery_code_used`. */
  kind: string;
  severity: 'info' | 'warn' | 'critical';
  at: string;
  staffId: string | null;
  deviceId: string | null;
  /** The payment and order a payment alert is about (ids only), so the owner can find it. */
  subject?: { paymentId: string; orderId: string };
}

/**
 * A synced order row changed (D-04, 02 §5). `rev` is the row's position in the global sync
 * sequence, so a client applies the event only if it is newer than what it holds.
 */
export interface OrderUpsertedEvent {
  type: 'order.upserted';
  id: string;
  rev: number;
  data: OrderDto;
}

/**
 * A synced payment row changed (02 §5 `payment.upserted`). `data` is the payment DTO: it shows the
 * masked PromptPay target only, never the ID or a QR payload.
 */
export interface PaymentUpsertedEvent {
  type: 'payment.upserted';
  id: string;
  rev: number;
  data: PaymentDto;
}

/** A new order exists: devices play the alert sound (02 §5). */
export interface NewOrderAlertEvent {
  type: 'alert.new_order';
  orderId: string;
  orderNo: string;
  channel: OrderChannel;
  status: OrderStatus;
  createdOnDeviceId: string | null;
}

/**
 * A setting changed (02 §5 `settings.updated`). `key` is the stored key (`shop`, `promptpay`,
 * `gov_copay` ...); `data` is the new value, except for `promptpay`, where it is only the masked
 * form (`{idType, idMasked}`): the ID itself never rides an event, and a device that needs it
 * refetches `GET /v1/settings/promptpay`. Subscribers must not log `data`.
 */
export interface SettingsUpdatedEvent {
  type: 'settings.updated';
  key: string;
  rev: number;
  version: number;
  data: unknown;
}

/**
 * A menu row changed (02 §5 `menu.upserted`): a category, item, modifier group or option.
 * `data` is the same shape the staff API returns for it (no costs).
 */
export interface MenuUpsertedEvent {
  type: 'menu.upserted';
  kind: 'category' | 'item' | 'group' | 'option';
  id: string;
  rev: number;
  data: unknown;
}

export type AppEvent =
  | SecurityAlertEvent
  | OrderUpsertedEvent
  | PaymentUpsertedEvent
  | NewOrderAlertEvent
  | SettingsUpdatedEvent
  | MenuUpsertedEvent;

export type EventHandler = (event: AppEvent) => void | Promise<void>;

export interface EventBus {
  publish(event: AppEvent): void;
  subscribe(handler: EventHandler): () => void;
}

/** A failing subscriber never breaks the request that published, or the other subscribers. */
export function createEventBus(onError: (error: unknown) => void = () => {}): EventBus {
  const handlers = new Set<EventHandler>();
  return {
    publish(event) {
      for (const handler of handlers) {
        try {
          void Promise.resolve(handler(event)).catch(onError);
        } catch (error) {
          onError(error);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
