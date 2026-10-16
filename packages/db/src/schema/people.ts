/**
 * Schema: customers, staff, owner credentials, devices, sessions and staff invites.
 */
import { DEVICE_KINDS, SESSION_KINDS, STAFF_ROLES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money, oneOf, sync, ts } from './columns.ts';

// ---------- People and devices ----------

export const customers = pgTable(
  'customers',
  {
    id: id(),
    lineUserId: text('line_user_id'),
    /**
     * The LINE display name and picture (owner, 2026-10-12), read from LINE when the customer opens
     * the app and refreshed at most weekly (`line_profile_at`). Personal data (PDPA): cleared by
     * `anonymizeCustomer`.
     */
    displayName: text('display_name'),
    pictureUrl: text('picture_url'),
    lineProfileAt: ts('line_profile_at'),
    nickname: text('nickname'),
    phone: text('phone'),
    roomNo: text('room_no'),
    note: text('note'),
    /**
     * The member profile (owner, 2026-10-11): `full_name` and `member_building` here, with
     * `nickname` and `phone` above. All optional, given by the customer at checkout. Personal data
     * (PDPA): cleared by `anonymizeCustomer`. Apart from `building` (the 30-day recipient book).
     */
    fullName: text('full_name'),
    memberBuilding: text('member_building'),
    /**
     * The recipient the shop last delivered to for this customer (owner, 2026-10-02), remembered
     * automatically from orders so the next order can show it. Personal data (PDPA): cleared by
     * `anonymizeCustomer` (owner-only `POST /v1/customers/{id}/anonymize`) and, 30 days after the
     * recipient's last order, by the retention job (`retention.ts`). `recipientKey` is the name
     * normalised by `recipientKey()` in `@sds/shared` (case, spacing, Unicode form). Only counter
     * and phone customers hold it: they are matched by (building, recipientKey). A LINE customer
     * is matched by `lineUserId` only and an order never writes these fields onto it.
     */
    building: text('building'),
    recipientName: text('recipient_name'),
    deliveryNote: text('delivery_note'),
    recipientKey: text('recipient_key'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastOrderAt: ts('last_order_at'),
    orderCount: integer('order_count').notNull().default(0),
    totalSpentSatang: money('total_spent_satang').notNull().default(0),
    privacyAckAt: ts('privacy_ack_at'),
    /** `PRIVACY_NOTICE_VERSION` at the time of the acknowledgement; null for one made before versions. */
    privacyAckVersion: text('privacy_ack_version'),
    marketingConsentAt: ts('marketing_consent_at'),
    unfollowedAt: ts('unfollowed_at'),
    anonymizedAt: ts('anonymized_at'),
    /**
     * Slip flag (owner decision): the bank-check service once said "fake slip" for this customer.
     * STAFF ONLY (never in a customer answer, a LINE message, sync, realtime or a log). It does not
     * stop ordering; it turns the automatic payment confirmation off. `slip_flag_at` null: no flag.
     * The count is a lifetime tally and stays after the owner clears the flag.
     */
    slipFlagAt: ts('slip_flag_at'),
    slipFlagReason: text('slip_flag_reason'),
    slipFlagCount: smallint('slip_flag_count').notNull().default(0),
    ...sync,
  },
  (t) => [
    uniqueIndex('customers_line_user_id_key').on(t.lineUserId),
    uniqueIndex('customers_recipient_key')
      .on(t.building, t.recipientKey)
      .where(sql`line_user_id is null`),
    index('customers_rev_idx').on(t.rev),
  ],
);

export const staff = pgTable(
  'staff',
  {
    id: id(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    pinHash: text('pin_hash'),
    active: boolean('active').notNull().default(true),
    failedPinCount: integer('failed_pin_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    /** Step-up (a signed-in session re-entering the PIN) counts and locks apart from sign-in. */
    stepUpFailedCount: integer('step_up_failed_count').notNull().default(0),
    stepUpLockedUntil: ts('step_up_locked_until'),
    /** Lock cycles since the last success: 5 min, then 1 h, then 24 h. Reset on a successful sign-in. */
    pinLockLevel: integer('pin_lock_level').notNull().default(0),
    stepUpLockLevel: integer('step_up_lock_level').notNull().default(0),
    ...sync,
  },
  (t) => [index('staff_rev_idx').on(t.rev), check('staff_role', oneOf('role', STAFF_ROLES))],
);

export const ownerCredentials = pgTable('owner_credentials', {
  staffId: uuid('staff_id')
    .primaryKey()
    .references(() => staff.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  /** Step-up counts and locks apart from the public sign-in above. */
  stepUpFailedCount: integer('step_up_failed_count').notNull().default(0),
  stepUpLockedUntil: ts('step_up_locked_until'),
  /** Highest TOTP time step already accepted: a code is single use (RFC 6238 §5.2). */
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** HMAC hashes of the unused one-time recovery codes. */
  recoveryCodeHashes: text('recovery_code_hashes').array().notNull().default(sql`'{}'::text[]`),
});

export const devices = pgTable(
  'devices',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
    ...sync,
  },
  (t) => [index('devices_rev_idx').on(t.rev), check('devices_kind', oneOf('kind', DEVICE_KINDS))],
);

/**
 * Login sessions (02 §7): opaque bearer tokens kept as a SHA-256 hash. Not synced to
 * clients, so there is no rev/version. Expiry is compared in application code.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id),
    /** The registered device a PIN session is bound to; null for an owner login without one. */
    deviceId: uuid('device_id').references(() => devices.id),
    /** Decides the idle timeout: a PIN session at the counter lives longer than an owner login. */
    kind: text('kind').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Absolute end of the session. */
    expiresAt: ts('expires_at').notNull(),
    /** Idle timeout is measured from here. */
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    /** Step-up (re-authentication) is valid until this instant. */
    stepUpUntil: ts('step_up_until'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('sessions_staff_id_idx').on(t.staffId),
    index('sessions_device_id_idx').on(t.deviceId),
    check('sessions_kind', oneOf('kind', SESSION_KINDS)),
  ],
);

/**
 * Invites for new accounts (D-23): an owner invites an e-mail + role and sends the single-use link
 * by hand. Only the token's hash is stored. Not synced to clients (no rev/version), like sessions.
 * `pendingTotpSecretEnc` is the authenticator secret shown at preview, AES-GCM under the TOTP key
 * with the invite id as associated data. One open (not accepted, not revoked) invite per e-mail.
 */
export const staffInvites = pgTable(
  'staff_invites',
  {
    id: id(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    displayName: text('display_name'),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => staff.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    pendingTotpSecretEnc: text('pending_totp_secret_enc'),
    /** Wrong authenticator codes at accept; the invite is revoked when the API's limit is reached. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
  },
  (t) => [
    uniqueIndex('staff_invites_open_email_idx')
      .on(t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index('staff_invites_created_by_idx').on(t.createdBy),
    check('staff_invites_role', oneOf('role', STAFF_ROLES)),
    check('staff_invites_email_lower', sql`${t.email} = lower(${t.email})`),
  ],
);
