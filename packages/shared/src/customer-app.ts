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
import { isoDateSchema, orderLineInputSchema } from './schemas.ts';

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

// ---------- Member page ----------

/** `GET` and `PUT /v1/app/member`: the saved profile, or null when every field is empty. The PUT body is `memberInputSchema`. */
export const memberResponseSchema = z.object({ member: memberProfileSchema.nullable() });
export type MemberResponse = z.infer<typeof memberResponseSchema>;

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

/**
 * `none`: no slip sent. `checking`: sent, the bank check is still running. `staff_review`: staff look
 * at it. `amount_mismatch`: the bank check found a different amount (D-42; the only failure told
 * apart). `verified_waiting`: the bank check passed but the shop still has to confirm (A2).
 */
export const CUSTOMER_SLIP_CHECKS = [
  'none',
  'checking',
  'staff_review',
  'amount_mismatch',
  'verified_waiting',
] as const;
export type CustomerSlipCheck = (typeof CUSTOMER_SLIP_CHECKS)[number];

/**
 * What the customer is told about the slip of their open PromptPay payment. Neutral on purpose
 * (owner decision) with one exception (D-42, 2026-10-24): a bank-checked amount mismatch. Every
 * other finished check (wrong receiver or date, not found, fraud, a duplicate, not checked) is the
 * same `staff_review`, so a cheater cannot learn which check failed. A pass on a payment that is
 * still open (held back from auto-confirm: ceiling, flagged customer) is `verified_waiting`; one
 * that auto-confirms leaves no open payment, so the app shows "paid" instead. Only a check still
 * running is `checking`; a slip with no check marked at all is staff's to look at.
 */
export function customerSlipCheck(slip: {
  hasSlip: boolean;
  slipVerify: string | null;
}): CustomerSlipCheck {
  if (!slip.hasSlip) return 'none';
  switch (slip.slipVerify) {
    case 'pending':
      return 'checking';
    case 'amount_mismatch':
      return 'amount_mismatch';
    case 'valid':
      return 'verified_waiting';
    default:
      return 'staff_review';
  }
}

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
  /**
   * Staff checked the bank and found no transfer: the customer's "โอนแล้ว" was rejected and nothing
   * is waiting. Show "payment not found, pay again or send the slip"; the pay actions below are on
   * again. Always sent by the server; optional so older fixtures still type-check.
   */
  paymentRejected: z.boolean().optional(),
  /** The customer has sent a slip for the waiting payment: the app offers "view" and "replace". */
  hasSlip: z.boolean().optional(),
  /**
   * Where the slip of the open PromptPay payment stands, in words that say nothing about the bank
   * check (owner decision: a cheater must not learn which check failed). Absent when no PromptPay
   * payment is open (nothing to pay, paid, closed). See `customerSlipCheck`.
   */
  slipCheck: z.enum(CUSTOMER_SLIP_CHECKS).optional(),
  /**
   * Slips can no longer be sent for this order: only the neutral fact, never why (owner decision).
   * Sent as `true` only while a slip could otherwise be attached; `actions.attachSlip` is then
   * false. The customer can still tap "โอนแล้ว" and staff verify by hand.
   */
  slipBlocked: z.boolean().optional(),
  /**
   * Too many slips were sent for the open payment: the next one is accepted after this many
   * seconds (SLIP_COOLDOWN_SECONDS after the last). Absent when a slip may be sent now. The claim
   * ("โอนแล้ว") is never held back by it.
   */
  slipRetryAfterSeconds: z.number().int().positive().optional(),
  /**
   * Why a cancelled order was cancelled (D-39, D-41), for the plain-words line on the order page.
   * Null while the order is open, or when no reason was recorded.
   */
  cancelReason: z.enum(['customer_cancel', 'unpaid_timeout', 'merged', 'other']).nullable(),
  /** For `cancelReason: 'merged'`: the number of the order that took the lines; else null. */
  mergedInto: z.string().nullable(),
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
    /** Change the dishes (D-39): only while `canCustomerEdit` holds. */
    edit: z.boolean(),
    /** Cancel the order (D-39): the same condition as `edit`. */
    cancel: z.boolean(),
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

// ---------- Edit, cancel, merge (D-39) ----------

const orderVersion = z.number().int().min(1);

/** `PUT /v1/app/orders/:id/items`: replaces all the lines. The server reprices and replaces the payment. */
export const appOrderEditInputSchema = z.strictObject({
  expectedVersion: orderVersion,
  items: z.array(orderLineInputSchema).min(1).max(50),
});
export type AppOrderEditInput = z.infer<typeof appOrderEditInputSchema>;

/** `POST /v1/app/orders/:id/cancel`. */
export const appOrderCancelInputSchema = z.strictObject({ expectedVersion: orderVersion });
export type AppOrderCancelInput = z.infer<typeof appOrderCancelInputSchema>;

/** Most orders folded into one in a single merge. */
export const MAX_MERGE_SOURCES = 10;

/**
 * `POST /v1/app/orders/:id/merge`: the order in the path survives and takes the lines of
 * `sourceIds`. `expectedVersion` is the survivor's; `expectedVersions[i]` is for `sourceIds[i]`.
 */
export const appOrderMergeInputSchema = z
  .strictObject({
    expectedVersion: orderVersion,
    sourceIds: z.array(z.uuid()).min(1).max(MAX_MERGE_SOURCES),
    expectedVersions: z.array(orderVersion).min(1).max(MAX_MERGE_SOURCES),
  })
  .refine((v) => v.sourceIds.length === v.expectedVersions.length, {
    message: 'one expected version for each source order',
    path: ['expectedVersions'],
  })
  .refine((v) => new Set(v.sourceIds).size === v.sourceIds.length, {
    message: 'each source order once',
    path: ['sourceIds'],
  });
export type AppOrderMergeInput = z.infer<typeof appOrderMergeInputSchema>;

/**
 * `GET /v1/app/orders/open`: the customer's unpaid, open LINE orders, for the checkout warning.
 * Carries what `isDuplicateCart` and the name/building/date merge check read; the server still
 * decides every merge.
 */
export const appOpenOrderSchema = z.object({
  id: z.uuid(),
  orderNo: z.string(),
  totalSatang: z.number().int().nonnegative(),
  version: orderVersion,
  businessDate: isoDateSchema,
  deliveryBuilding: z.string().nullable(),
  recipientName: z.string().nullable(),
  placedAt: isoInstant,
  items: z.array(
    z.object({
      menuItemId: z.uuid(),
      nameTh: z.string(),
      nameEn: z.string().nullable(),
      qty: z.number().int().min(1),
      modifierOptionIds: z.array(z.uuid()),
      /** The line's note, so an edit or a merge from the app does not lose it. Absent from an older server. */
      note: z.string().nullable().optional(),
    }),
  ),
});
export type AppOpenOrder = z.infer<typeof appOpenOrderSchema>;

export const appOpenOrdersSchema = z.object({ orders: z.array(appOpenOrderSchema) });
export type AppOpenOrders = z.infer<typeof appOpenOrdersSchema>;

/**
 * The answer (`details` of the 409 `NEEDS_COMBINE`) to a slip upload whose amount equals this order
 * plus the customer's other open orders (D-40). The slip is not stored; the app asks to combine.
 */
export const slipNeedsCombineSchema = z.object({
  orderNos: z.array(z.string()).min(2),
  orderIds: z.array(z.uuid()).min(2),
  totalSatang: z.number().int().positive(),
});
export type SlipNeedsCombine = z.infer<typeof slipNeedsCombineSchema>;
