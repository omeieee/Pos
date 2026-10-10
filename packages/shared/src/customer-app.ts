/**
 * The customer app's API shapes (`/v1/app/...`, docs/04 §1.5). Pure; no I/O.
 *
 * - A customer is a LINE user signed in with a LIFF token. They never send a price, a channel, a
 *   fulfilment, a customer id or a staff id: the server fixes those (`line`, entrance delivery,
 *   the session's customer). Every request object is strict, so a client that sends one gets a
 *   400 instead of having it silently dropped.
 * - Responses are the customer's own view: no staff ids, no costs, no version counters.
 * - The server decides what the customer may do next (`actions`); the app only shows it.
 */
import { z } from 'zod';
import { buildingNameSchema, deliveryNoteSchema, recipientNameSchema } from './delivery.ts';
import { ORDER_PAYMENT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from './enums.ts';
import { memberInputSchema, memberProfileSchema } from './member.ts';
import { orderLineInputSchema } from './schemas.ts';

const isoInstant = z.iso.datetime();

/** Most items, counted by quantity, in one customer order. */
export const MAX_ORDER_QUANTITY = 50;

/** What a customer can choose. Cash and ไทยช่วยไทย are paid at the hand-over; staff confirm. */
export const APP_PAY_METHODS = ['cash', 'promptpay', 'gov_copay'] as const;
export type AppPayMethod = (typeof APP_PAY_METHODS)[number];
export const appPayMethodSchema = z.enum(APP_PAY_METHODS);

// ---------- Session ----------

/**
 * One LIFF credential: the ID token (`liff.getIDToken()`, needs the `openid` scope) or the access
 * token (`liff.getAccessToken()`). The server verifies it with LINE; nothing the client says about
 * who it is (a user id) is ever read.
 */
export const customerSessionRequestSchema = z.union([
  z.strictObject({ idToken: z.string().min(20).max(4096) }),
  z.strictObject({ accessToken: z.string().min(20).max(4096) }),
]);
export type CustomerSessionRequest = z.infer<typeof customerSessionRequestSchema>;

export const customerSessionResponseSchema = z.object({
  /** Send as `Authorization: Bearer <token>`. Short-lived: ask again with a fresh LIFF token. */
  token: z.string(),
  expiresAt: isoInstant,
  privacyAcknowledged: z.boolean(),
  /** The notice version the customer must have acknowledged to order. */
  privacyVersion: z.string(),
});
export type CustomerSessionResponse = z.infer<typeof customerSessionResponseSchema>;

export const privacyAckResponseSchema = z.object({
  privacyAcknowledged: z.literal(true),
  privacyVersion: z.string(),
});
export type PrivacyAckResponse = z.infer<typeof privacyAckResponseSchema>;

// ---------- Checkout info ----------

export const checkoutInfoSchema = z.object({
  /** Whether the shop delivers right now, and today's window as minutes from local midnight. */
  delivery: z.object({
    open: z.boolean(),
    window: z.object({ openMinute: z.number().int(), closeMinute: z.number().int() }).nullable(),
    /** The owner's LINE ordering switch; absent from an older server (the hours then decide). */
    mode: z.enum(['open', 'closed', 'scheduled']).optional(),
  }),
  /** The buildings the shop delivers to (owner-editable list). */
  buildings: z.array(z.string()),
  /** The methods on offer right now. ไทยช่วยไทย appears only when the scheme is enabled and in window. */
  methods: z.array(appPayMethodSchema),
  /**
   * The recipient of the customer's last order, for reference (owner, 2026-10-02): the building,
   * name and note to prefill. Null when none, or once the retention job has erased it.
   */
  lastRecipient: z
    .object({
      building: z.string(),
      recipientName: z.string(),
      deliveryNote: z.string().nullable(),
    })
    .nullable(),
  /** The member profile saved for this customer, to prefill the form (owner, 2026-10-11). Absent from an older server. */
  member: memberProfileSchema.optional(),
  privacyAcknowledged: z.boolean(),
  privacyVersion: z.string(),
  /** The shop's PromptPay ID for the "transfer by hand" text (null until the owner sets one). */
  promptpayConfigured: z.boolean(),
  /** The shop's phone number from the shop settings, for a "call us" link; null when none is saved. */
  shopPhone: z.string().max(30).nullable().optional(),
});
export type CheckoutInfo = z.infer<typeof checkoutInfoSchema>;

// ---------- Orders ----------

/** Place an order. The server prices it, numbers it and fixes channel, fulfilment and customer. */
export const appOrderInputSchema = z.strictObject({
  clientRequestId: z.uuid(),
  items: z.array(orderLineInputSchema).min(1).max(50),
  deliveryBuilding: buildingNameSchema,
  recipientName: recipientNameSchema,
  deliveryNote: deliveryNoteSchema.optional(),
  note: z.string().max(500).optional(),
  paymentMethod: appPayMethodSchema,
  /**
   * The member form (owner, 2026-10-11), sent with the payment method in this one call. All fields
   * optional; a field left out keeps the saved value, an empty string clears it. Saved on the
   * customer and copied onto the order. Ignored on a replay of an order that was already saved.
   */
  member: memberInputSchema.optional(),
});
export type AppOrderInput = z.infer<typeof appOrderInputSchema>;

/** Choose or change how to pay. `clientRequestId` makes a retry safe; the server makes one if absent. */
export const selectPaymentInputSchema = z.strictObject({
  method: appPayMethodSchema,
  clientRequestId: z.uuid().optional(),
});
export type SelectPaymentInput = z.infer<typeof selectPaymentInputSchema>;

export const myPaymentSchema = z.object({
  id: z.uuid(),
  method: z.enum(['cash', 'promptpay', 'gov_copay', 'platform', 'other']),
  status: z.enum(PAYMENT_STATUSES),
  /** Always the order total. */
  amountSatang: z.number().int().nonnegative(),
});
export type MyPayment = z.infer<typeof myPaymentSchema>;

export const myOrderSchema = z.object({
  id: z.uuid(),
  orderNo: z.string(),
  status: z.enum(ORDER_STATUSES),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUSES),
  subtotalSatang: z.number().int().nonnegative(),
  totalSatang: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      nameTh: z.string(),
      nameEn: z.string().nullable(),
      qty: z.number().int(),
      modifiers: z.array(z.object({ nameTh: z.string(), nameEn: z.string().nullable() })),
      note: z.string().nullable(),
      lineTotalSatang: z.number().int().nonnegative(),
    }),
  ),
  deliveryBuilding: z.string().nullable(),
  recipientName: z.string().nullable(),
  deliveryNote: z.string().nullable(),
  note: z.string().nullable(),
  placedAt: isoInstant,
  readyAt: isoInstant.nullable(),
  completedAt: isoInstant.nullable(),
  cancelledAt: isoInstant.nullable(),
  /** The payment still open (pending or claimed) or, failing that, the latest one; null for cash. */
  payment: myPaymentSchema.nullable(),
  /** What the customer may do next. The server decides; the app shows. */
  actions: z.object({
    /** "โอนแล้ว": only for a pending PromptPay payment. It makes the payment `claimed`; staff confirm. */
    claim: z.boolean(),
    /** Change the method (only while nothing is claimed, confirmed or closed). */
    changeMethod: z.boolean(),
    /** Show the PromptPay QR (fresh every time). */
    showQr: z.boolean(),
    /** Attach (or replace) the transfer slip picture: while a PromptPay payment is pending or claimed. */
    attachSlip: z.boolean(),
    /** The methods the customer can switch to right now. */
    methods: z.array(appPayMethodSchema),
  }),
});
export type MyOrder = z.infer<typeof myOrderSchema>;

export const appOrderResultSchema = z.object({
  order: myOrderSchema,
  /**
   * Set when the order was saved but the PromptPay or ไทยช่วยไทย payment could not be started (for
   * example the scheme closed in between): the customer picks a method again on the order page.
   */
  paymentError: z.string().nullable(),
  replay: z.boolean(),
});
export type AppOrderResult = z.infer<typeof appOrderResultSchema>;

export const myOrdersResponseSchema = z.object({ orders: z.array(myOrderSchema) });
export type MyOrdersResponse = z.infer<typeof myOrdersResponseSchema>;

/**
 * A fresh, short-lived link to the PromptPay QR picture of the customer's own order, for the exact
 * order total. The picture is rebuilt from the current PromptPay ID each time it is fetched; fetch
 * a new link every time the QR is shown (the link lasts five minutes).
 */
export const myQrResponseSchema = z.object({
  /** Path and query on the API origin. */
  url: z.string(),
  expiresAt: isoInstant,
  amountSatang: z.number().int().nonnegative(),
  /** The shop's PromptPay ID, shown as text with the exact amount for a manual transfer. */
  promptpayId: z.string(),
});
export type MyQrResponse = z.infer<typeof myQrResponseSchema>;
