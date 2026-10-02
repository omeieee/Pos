/** Domain enums (03-data-model §3). Values are stored in the DB as text. */

export const ORDER_CHANNELS = ['storefront', 'line', 'grab', 'lineman', 'phone'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const MENU_CHANNELS = ['storefront', 'line', 'grab', 'lineman'] as const;
export type MenuChannel = (typeof MENU_CHANNELS)[number];

/**
 * How an order reaches the customer. Since 2026-10-02 the shop only DELIVERS TO THE BUILDING
 * ENTRANCE (`entrance_delivery`: the condominium bans outside visitors, a guard is stationed at
 * the entrance and the customer comes down to receive the order, no delivery fee) or hands the
 * order to a delivery platform (`platform_delivery`). The other values are legacy: they stay valid
 * so old rows and history keep working, but `allowedFulfillments` never offers them.
 */
export const FULFILLMENTS = [
  'dine_in',
  'takeaway',
  'pickup',
  'room_delivery',
  'platform_delivery',
  'entrance_delivery',
] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PAYMENT_STATUSES = [
  'unpaid',
  'awaiting_confirmation',
  'partially_paid',
  'paid',
  'refunded',
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['cash', 'promptpay', 'gov_copay', 'platform', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'claimed',
  'confirmed',
  'cancelled',
  'voided',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const STAFF_ROLES = ['owner', 'manager', 'cashier', 'kitchen'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const DEVICE_KINDS = ['ipad', 'iphone', 'laptop', 'print_agent', 'display'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const EXPENSE_CATEGORIES = [
  'ingredients',
  'packaging',
  'gas',
  'utilities',
  'rent',
  'staff',
  'platform_fees',
  'equipment',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** How a session was opened: a staff PIN on a registered device, or the owner's password + TOTP. */
export const SESSION_KINDS = ['pin', 'owner'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const AUDIT_ACTOR_TYPES = ['staff', 'customer', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Display prefix of the daily order number (03 §5): S-013, L-014 … */
export const ORDER_NO_PREFIX: Record<OrderChannel, string> = {
  storefront: 'S',
  line: 'L',
  grab: 'G',
  lineman: 'M',
  phone: 'P',
};
