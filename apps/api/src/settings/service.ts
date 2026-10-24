/**
 * Settings (02 §6, CLAUDE.md rules 3, 4, 9). Each resource is a row of `settings` (or the
 * `gov_copay_schemes` row). A PATCH is one transaction: lock the row, check `expectedVersion`
 * (0 = never saved), merge, validate the whole result, write (the sync trigger bumps version and
 * rev), audit, then publish after commit.
 *
 * The PromptPay ID and the co-pay scheme move money, so only the owner may change them, after a
 * step-up (the route guard checks), with an audit row and an alert on every change. The full ID
 * is never written to an audit row, a log or an alert: only its masked form (plus a count of the
 * PromptPay payments still open, which are left as they are).
 */
import {
  type Db,
  type GovCopayRow,
  getGovCopayRow,
  getSettingRow,
  insertAudit,
  insertGovCopayRow,
  insertSettingRow,
  lockGovCopayRow,
  lockSettingRow,
  paymentsRepo,
  type SettingRow,
  type syncRepo,
  updateGovCopayRowIfVersion,
  updateSettingRowIfVersion,
} from '@sds/db';
import {
  type BankAccountSettings,
  type BankAccountView,
  bankAccountPatchInputSchema,
  bankAccountSettingsSchema,
  businessDaySettingsSchema,
  type CashOpeningSettings,
  cashOpeningEarliest,
  cashOpeningPatchInputSchema,
  cashOpeningSettingsSchema,
  DEFAULT_BANK_ACCOUNT,
  DEFAULT_CASH_OPENING,
  DEFAULT_CUTOFF_MINUTES,
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_LINE_ORDERING,
  DEFAULT_OPENING_HOURS,
  DEFAULT_PLATFORM_COMMISSION,
  DEFAULT_PRINTING,
  DEFAULT_RECEIPT_SETTINGS,
  DEFAULT_SHOP_SETTINGS,
  DEFAULT_UNPAID_TIMEOUT,
  type DeliverySettings,
  deliveryPatchInputSchema,
  deliverySettingsSchema,
  type GovCopayDto,
  type GovCopayResponse,
  govCopayDtoSchema,
  govCopayPatchInputSchema,
  govCopaySchemeSchema,
  hasPermission,
  lineOrderingOpenAt,
  lineOrderingPatchInputSchema,
  lineOrderingSchema,
  maskBankAccount,
  maskPromptpayId,
  numberingPatchInputSchema,
  type OpeningHours,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  type PaymentsSettings,
  type Permission,
  type PlatformCommissionSettings,
  type PromptpaySettings,
  paymentsPatchInputSchema,
  paymentsSettingsSchema,
  platformCommissionPatchInputSchema,
  platformCommissionSettingsSchema,
  printingPatchInputSchema,
  printingSettingsSchema,
  promptpayPatchInputSchema,
  promptpaySettingsSchema,
  type ReceiptSettings,
  receiptPatchInputSchema,
  receiptSettingsSchema,
  SHOP_TIME_ZONE,
  type StaffRole,
  shopPatchInputSchema,
  shopSettingsSchema,
  type UnpaidTimeoutSettings,
  unpaidTimeoutPatchInputSchema,
  unpaidTimeoutSettingsSchema,
} from '@sds/shared';
import type { z } from 'zod';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { ApiError, cashOpeningTooOld, versionConflict } from '../errors.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';

// ---------- Key/value resources ----------

interface Resource {
  /** The path segment under /v1/settings. */
  route: string;
  /** The `settings.key` it is stored under. */
  key: string;
  schema: z.ZodType;
  /** What GET shows before it is ever saved. `null` = there is no default (the PromptPay ID). */
  defaults: unknown;
  patch: z.ZodType;
  editPermission: Permission;
  /** Special handling for the PromptPay ID. */
  promptpay?: true;
  /** The receipt tax ID and address: own audit action and owner alert; never put on the realtime feed. */
  receipt?: true;
  /**
   * The shop's receiving bank account (D-26): own audit action and owner alert, never on the
   * realtime feed, and GET answers only a masked view (the full number leaves the server nowhere).
   */
  bankAccount?: true;
  /**
   * The Grab and LINE MAN commission rates (2026-10-20): owner only, step-up, audit, alert. Not on
   * the realtime feed (reports read it from the server). Reading is owner only too (`finance.pnl`,
   * no step-up; owner-approved 2026-10-21): `settings.view` does not read these rates, and the
   * response is masked to "not set" for any other role as a second line of defence.
   */
  platformCommission?: true;
  /**
   * The start amount of the receipts-payments report (D-35, stored as `cash_opening`): handled like the commission rates. Owner only to read
   * (`finance.pnl`) and to change (step-up), audited, alerted, never on the realtime feed.
   */
  cashOpening?: true;
  /** Who may read it. Defaults to `settings.view`. */
  viewPermission?: Permission;
  /** The change also answers PUT (a whole-value replacement) besides PATCH. Same handler. */
  put?: true;
}

const businessDayDefaults = { cutoffMinutes: DEFAULT_CUTOFF_MINUTES, timeZone: SHOP_TIME_ZONE };

export const RESOURCES: readonly Resource[] = [
  {
    route: 'shop',
    key: 'shop',
    schema: shopSettingsSchema,
    defaults: DEFAULT_SHOP_SETTINGS,
    patch: shopPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    route: 'opening-hours',
    key: 'opening_hours',
    schema: openingHoursSchema,
    defaults: DEFAULT_OPENING_HOURS,
    patch: openingHoursPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    // Whether LINE takes orders: always, never, or by the delivery hours (the default).
    route: 'line-ordering',
    key: 'line_ordering',
    schema: lineOrderingSchema,
    defaults: DEFAULT_LINE_ORDERING,
    patch: lineOrderingPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    // The business day and the order numbering that restarts with it (03 §5).
    route: 'numbering',
    key: 'business_day',
    schema: businessDaySettingsSchema,
    defaults: businessDayDefaults,
    patch: numberingPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    // Whether new orders are sent to the print host (owner, 2026-10-22). Not a money setting:
    // settings.edit, no step-up, an audit row. Not on the realtime feed.
    route: 'printing',
    key: 'printing',
    schema: printingSettingsSchema,
    defaults: DEFAULT_PRINTING,
    patch: printingPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    // Unpaid pay-first LINE orders are cancelled after this many minutes (D-41). Not a money
    // setting: settings.edit, no step-up, an audit row. Not on the realtime feed.
    route: 'unpaid-timeout',
    key: 'unpaid_timeout',
    schema: unpaidTimeoutSettingsSchema,
    defaults: DEFAULT_UNPAID_TIMEOUT,
    patch: unpaidTimeoutPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    route: 'payments',
    key: 'payment_methods',
    schema: paymentsSettingsSchema,
    defaults: paymentsSettingsSchema.parse({}),
    patch: paymentsPatchInputSchema,
    editPermission: 'settings.edit',
  },
  {
    // The buildings the shop delivers to (owner, 2026-10-02): every order is delivered to the
    // entrance of one of them. Not a money setting: settings.edit, no step-up, an audit row.
    route: 'delivery',
    key: 'delivery',
    schema: deliverySettingsSchema,
    defaults: DEFAULT_DELIVERY_SETTINGS,
    patch: deliveryPatchInputSchema,
    editPermission: 'settings.edit',
    put: true,
  },
  {
    route: 'promptpay',
    key: 'promptpay',
    schema: promptpaySettingsSchema,
    defaults: null,
    patch: promptpayPatchInputSchema,
    editPermission: 'settings.promptpay',
    promptpay: true,
  },
  {
    // The tax ID and address printed on receipts (owner, 2026-10-11): owner only, step-up, audit,
    // alert. Empty until the owner enters them. Read by the receipt endpoint, not synced.
    route: 'receipt',
    key: 'receipt',
    schema: receiptSettingsSchema,
    defaults: DEFAULT_RECEIPT_SETTINGS,
    patch: receiptPatchInputSchema,
    editPermission: 'settings.receipt',
    receipt: true,
  },
  {
    // The account slips are compared with (2026-10-11): owner only, step-up, audit, alert. Only the
    // masked form is ever returned, and only to the owner; nobody else learns more than "set".
    route: 'bank-account',
    key: 'bank_account',
    schema: bankAccountSettingsSchema,
    defaults: DEFAULT_BANK_ACCOUNT,
    patch: bankAccountPatchInputSchema,
    editPermission: 'settings.bank_account',
    bankAccount: true,
  },
  {
    // What Grab and LINE MAN keep of a sale, entered by the owner from the merchant app. No
    // built-in value: both are null until set, and reports then say "rate not set".
    route: 'platform-commission',
    key: 'platform_commission',
    schema: platformCommissionSettingsSchema,
    defaults: DEFAULT_PLATFORM_COMMISSION,
    patch: platformCommissionPatchInputSchema,
    editPermission: 'settings.platform_commission',
    platformCommission: true,
    viewPermission: 'finance.pnl',
  },
  {
    // The owner's start amount at the start of a business day, from which the report keeps a
    // running net (receipts minus payments). Stored key kept as `cash_opening` (D-35). No built-in value: both null until the owner sets them.
    route: 'cash-opening',
    key: 'cash_opening',
    schema: cashOpeningSettingsSchema,
    defaults: DEFAULT_CASH_OPENING,
    patch: cashOpeningPatchInputSchema,
    editPermission: 'settings.cash_opening',
    cashOpening: true,
    viewPermission: 'finance.pnl',
  },
];

export interface SettingResponse {
  value: unknown;
  version: number;
  rev: number;
  updatedAt: string | null;
}

/** The bank account as GET shows it: masked for the owner, only "set or not" for everyone else. */
export function bankAccountView(value: BankAccountSettings, role: StaffRole): BankAccountView {
  const owner = hasPermission(role, 'settings.bank_account');
  return {
    bankCode: owner ? value.bankCode : null,
    accountMasked: owner && value.accountNumber ? maskBankAccount(value.accountNumber) : null,
    configured: value.accountNumber !== null,
  };
}

function toResponse(
  resource: Resource,
  row: SettingRow | undefined,
  role: StaffRole,
): SettingResponse {
  const shown = (value: unknown) =>
    resource.bankAccount
      ? bankAccountView(value as BankAccountSettings, role)
      : (resource.platformCommission || resource.cashOpening) && role !== 'owner'
        ? resource.defaults
        : value;
  if (!row) return { value: shown(resource.defaults), version: 0, rev: 0, updatedAt: null };
  return {
    value: shown(resource.schema.parse(row.value)),
    version: row.version,
    rev: row.rev,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readSetting(
  ctx: AuthContext,
  resource: Resource,
  role: StaffRole,
): Promise<SettingResponse> {
  return toResponse(resource, await getSettingRow(ctx.db, resource.key), role);
}

/** The PromptPay ID the QR must use right now, read from settings every time (rule 3). */
export async function currentPromptpayId(db: Db): Promise<PromptpaySettings | null> {
  const row = await getSettingRow(db, 'promptpay');
  return row ? promptpaySettingsSchema.parse(row.value) : null;
}

/**
 * The per-platform commission rates for the reports (D-31, D-32), read from settings every time.
 * Never saved = both `null` ("rate not set"): there is no built-in rate.
 */
export async function currentPlatformCommission(db: Db): Promise<PlatformCommissionSettings> {
  const row = await getSettingRow(db, 'platform_commission');
  return row ? platformCommissionSettingsSchema.parse(row.value) : DEFAULT_PLATFORM_COMMISSION;
}

/** The start amount for the receipts-payments report, read from settings every time. Never saved = both `null`. */
export async function currentCashOpening(db: Db): Promise<CashOpeningSettings> {
  const row = await getSettingRow(db, 'cash_opening');
  return row ? cashOpeningSettingsSchema.parse(row.value) : DEFAULT_CASH_OPENING;
}

/**
 * The shop's receiving account with its bank code, read at bank-check time (D-27). Null unless
 * BOTH are set: Slip2Go needs the bank to type the account. Never returned by a route.
 */
export async function currentBankAccount(
  db: Db,
): Promise<{ bankCode: string; accountNumber: string } | null> {
  const row = await getSettingRow(db, 'bank_account');
  const parsed = row ? bankAccountSettingsSchema.safeParse(row.value) : null;
  if (!parsed?.success || !parsed.data.bankCode || !parsed.data.accountNumber) return null;
  return { bankCode: parsed.data.bankCode, accountNumber: parsed.data.accountNumber };
}

/**
 * The shop's receiving account number, read at slip-check time (D-26). Never returned by a route.
 * A missing or damaged row is just "no account": it must not break the PromptPay comparison.
 */
export async function currentBankAccountNumber(db: Db): Promise<string | null> {
  const row = await getSettingRow(db, 'bank_account');
  const parsed = row ? bankAccountSettingsSchema.safeParse(row.value) : null;
  return parsed?.success ? parsed.data.accountNumber : null;
}

/**
 * The buildings an order may be delivered to: the saved list, or the default when it was never
 * saved (production has no settings rows until the owner saves one). A damaged row fails loudly.
 */
export async function currentDeliverySettings(db: Db): Promise<DeliverySettings> {
  const row = await getSettingRow(db, 'delivery');
  return row ? deliverySettingsSchema.parse(row.value) : DEFAULT_DELIVERY_SETTINGS;
}

/** The shop's public phone number (settings `shop`), or null when none is saved. */
export async function currentShopPhone(db: Db): Promise<string | null> {
  const row = await getSettingRow(db, 'shop');
  return row ? shopSettingsSchema.parse(row.value).phone : null;
}

/** The tax ID and address for receipts: the saved ones, or both empty when never saved. */
export async function currentReceiptSettings(db: Db): Promise<ReceiptSettings> {
  const row = await getSettingRow(db, 'receipt');
  return row ? receiptSettingsSchema.parse(row.value) : DEFAULT_RECEIPT_SETTINGS;
}

/** The opening hours now in force: the saved ones, or the defaults when never saved. */
export async function currentOpeningHours(db: Db): Promise<OpeningHours> {
  const row = await getSettingRow(db, 'opening_hours');
  return row ? openingHoursSchema.parse(row.value) : DEFAULT_OPENING_HOURS;
}

/** Whether LINE takes an order now, by the owner's switch and (when scheduled) the delivery hours. */
export async function lineOrderingNow(db: Db, instant: Date) {
  const row = await getSettingRow(db, 'line_ordering');
  const { mode } = row ? lineOrderingSchema.parse(row.value) : DEFAULT_LINE_ORDERING;
  return lineOrderingOpenAt(mode, await currentOpeningHours(db), instant);
}

/** Whether new orders create a kitchen print job: the saved switch, or off when never saved. */
export async function currentPrintingEnabled(db: Db): Promise<boolean> {
  const row = await getSettingRow(db, 'printing');
  return (row ? printingSettingsSchema.parse(row.value) : DEFAULT_PRINTING).enabled;
}

/** The unpaid-order timeout now in force: the saved one, or the default (on, 60 minutes). */
export async function currentUnpaidTimeout(db: Db): Promise<UnpaidTimeoutSettings> {
  const row = await getSettingRow(db, 'unpaid_timeout');
  return row ? unpaidTimeoutSettingsSchema.parse(row.value) : DEFAULT_UNPAID_TIMEOUT;
}

/** The payment methods the shop takes now: the saved switches, or the defaults when never saved. */
export async function currentPaymentsSettings(db: Db): Promise<PaymentsSettings> {
  const row = await getSettingRow(db, 'payment_methods');
  return paymentsSettingsSchema.parse(row?.value ?? {});
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Top-level fields whose value differs, as before/after objects for the audit row. */
function changes(before: unknown, after: unknown) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!same(b[key], a[key])) {
      if (key in b) beforeOut[key] = b[key];
      if (key in a) afterOut[key] = a[key];
    }
  }
  return { before: beforeOut, after: afterOut };
}

/** For the audit row: the bank code and the last digits, never the number. */
const maskedBankAccount = (value: BankAccountSettings | null) => ({
  bankCode: value?.bankCode ?? null,
  accountMasked: value?.accountNumber ? maskBankAccount(value.accountNumber) : null,
});

const maskedPromptpay = (value: PromptpaySettings | null) =>
  value ? { idType: value.idType, idMasked: maskPromptpayId(value.idValue) } : null;

/** The start date is refused when it is more than 10 years before today's business date (422). */
export async function assertCashOpeningNotTooOld(
  db: Db,
  now: Date,
  value: CashOpeningSettings,
): Promise<void> {
  if (value.asOf === null) return;
  const earliest = cashOpeningEarliest(await currentBusinessDate(db, now));
  if (value.asOf < earliest) throw cashOpeningTooOld();
}

export async function patchSetting(
  ctx: AuthContext,
  actor: Principal,
  resource: Resource,
  body: unknown,
  meta: RequestMeta,
): Promise<SettingResponse> {
  const input = parse(resource.patch, body) as { expectedVersion: number } & Record<
    string,
    unknown
  >;
  const { expectedVersion, ...fields } = input;
  const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

  return withTransaction(ctx, async (tx, emit) => {
    const row = await lockSettingRow(tx, resource.key);
    const version = row?.version ?? 0;
    if (expectedVersion !== version) throw versionConflict(version);

    const current = row ? resource.schema.parse(row.value) : resource.defaults;
    const next = parse(resource.schema, { ...((current as object | null) ?? {}), ...given });
    if (resource.cashOpening)
      await assertCashOpeningNotTooOld(tx, ctx.now(), next as CashOpeningSettings);
    if (row && same(current, next)) return toResponse(resource, row, actor.role); // nothing to change

    const saved = row
      ? await updateSettingRowIfVersion(tx, resource.key, version, next, actor.staffId)
      : await insertSettingRow(tx, resource.key, next, actor.staffId);
    if (!saved) throw versionConflict(version + 1); // another request created or changed it first

    // Warn, do not cancel (owner, 2026-10-02): a count of PromptPay payments still open under the
    // old ID goes to the audit row and the alert, so the owner can check them. Never an ID.
    const openPromptpay = resource.promptpay
      ? await paymentsRepo.countOpenByMethod(tx, 'promptpay')
      : 0;
    const view = resource.bankAccount
      ? {
          before: maskedBankAccount(current as BankAccountSettings),
          after: maskedBankAccount(next as BankAccountSettings),
        }
      : resource.promptpay
        ? {
            before: maskedPromptpay(current as PromptpaySettings | null),
            after: {
              ...maskedPromptpay(next as PromptpaySettings),
              openPromptpayPayments: openPromptpay,
            },
          }
        : changes(current, next);
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: resource.promptpay
        ? 'settings.promptpay_change'
        : resource.receipt
          ? 'settings.receipt_change'
          : resource.bankAccount
            ? 'settings.bank_account_change'
            : resource.platformCommission
              ? 'settings.platform_commission_change'
              : resource.cashOpening
                ? 'settings.cash_opening_change'
                : 'settings.update',
      entity: 'settings',
      entityId: resource.key,
      before: view.before,
      after: view.after,
      ip: meta.ip,
    });
    if (resource.promptpay) {
      emit(
        securityAlert(ctx, 'settings.promptpay_changed', 'critical', {
          staffId: actor.staffId,
          deviceId: actor.deviceId,
          detail: { openPromptpayPayments: openPromptpay },
        }),
      );
    }
    if (
      resource.receipt ||
      resource.bankAccount ||
      resource.platformCommission ||
      resource.cashOpening
    ) {
      // The tax ID, the address and the account number never ride the realtime feed; the
      // commission rates are not a synced setting either.
      const kind = resource.bankAccount
        ? 'settings.bank_account_changed'
        : resource.platformCommission
          ? 'settings.platform_commission_changed'
          : resource.cashOpening
            ? 'settings.cash_opening_changed'
            : 'settings.receipt_changed';
      emit(securityAlert(ctx, kind, 'warn', { staffId: actor.staffId, deviceId: actor.deviceId }));
      return toResponse(resource, saved, actor.role);
    }
    emit({
      type: 'settings.updated',
      key: resource.key,
      rev: saved.rev,
      version: saved.version,
      // The ID itself never rides an event (the fan-out would carry it to every device); a device
      // that needs it reads GET /v1/settings/promptpay, which needs `settings.view`.
      data: resource.promptpay ? maskedPromptpay(next as PromptpaySettings) : next,
    });
    return toResponse(resource, saved, actor.role);
  });
}

// ---------- Government co-pay scheme ----------

const schemeFieldNames = [
  'govShareBp',
  'govDailyCapSatang',
  'govTotalCapSatang',
  'activeFrom',
  'activeTo',
  'activeFromMinute',
  'activeToMinute',
  'channels',
  'enabled',
] as const;

/** The shared scheme rules plus what turning it ON needs: a share and at least one channel. */
const enablingSchemeSchema = govCopaySchemeSchema.superRefine((scheme, ctx) => {
  if (!scheme.enabled) return;
  if (scheme.channels.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['channels'], message: 'at least one channel to enable' });
  }
  if (scheme.govShareBp <= 0) {
    ctx.addIssue({ code: 'custom', path: ['govShareBp'], message: 'a share above 0 to enable' });
  }
});

export function toDto(row: syncRepo.SyncSchemeRow): GovCopayDto {
  return govCopayDtoSchema.parse(row);
}

function fieldsOf(row: GovCopayRow) {
  const dto = toDto(row);
  return Object.fromEntries(schemeFieldNames.map((k) => [k, dto[k]]));
}

export async function readGovCopay(ctx: AuthContext): Promise<GovCopayResponse> {
  const row = await getGovCopayRow(ctx.db);
  return { scheme: row ? toDto(row) : null };
}

export async function patchGovCopay(
  ctx: AuthContext,
  actor: Principal,
  body: unknown,
  meta: RequestMeta,
): Promise<GovCopayResponse> {
  const input = parse(govCopayPatchInputSchema, body);
  const { expectedVersion, code, nameTh, nameEn, settlementNote, ...rest } = input;
  const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));

  return withTransaction(ctx, async (tx, emit) => {
    const row = await lockGovCopayRow(tx);
    const version = row?.version ?? 0;
    if (expectedVersion !== version) throw versionConflict(version);

    if (row && code !== undefined && code !== row.code) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The request is not valid', {
        issues: [{ path: 'code', code: 'custom' }],
      });
    }
    const base = row ? fieldsOf(row) : {};
    const scheme = parse(enablingSchemeSchema, { ...base, ...given });
    // Rule 4: face to face only. A scheme may be ON only with channels exactly ['storefront'];
    // switching OFF, or saving other fields while it stays off, is always allowed.
    if (scheme.enabled && !(scheme.channels.length === 1 && scheme.channels[0] === 'storefront')) {
      throw new ApiError(
        422,
        'COPAY_CHANNELS_NOT_STOREFRONT',
        'The scheme can be enabled only for storefront orders',
        { issues: [{ path: 'channels', code: 'custom' }] },
      );
    }
    if (!row && nameTh === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The request is not valid', {
        issues: [{ path: 'nameTh', code: 'invalid_type' }],
      });
    }

    const columns = {
      ...scheme,
      ...(nameTh !== undefined ? { nameTh } : {}),
      ...(nameEn !== undefined ? { nameEn } : {}),
      ...(settlementNote !== undefined ? { settlementNote } : {}),
    };
    let saved: GovCopayRow | undefined;
    if (row) {
      const was = {
        ...fieldsOf(row),
        nameTh: row.nameTh,
        nameEn: row.nameEn,
        settlementNote: row.settlementNote,
      };
      const view = changes(was, {
        ...was,
        ...scheme,
        ...(nameTh !== undefined ? { nameTh } : {}),
        ...(nameEn !== undefined ? { nameEn } : {}),
        ...(settlementNote !== undefined ? { settlementNote } : {}),
      });
      if (Object.keys(view.after).length === 0) return { scheme: toDto(row) }; // nothing to change
      saved = await updateGovCopayRowIfVersion(tx, row.id, version, columns);
      if (!saved) throw versionConflict(version);
      await audit(tx, actor, meta, saved.id, view.before, view.after);
    } else {
      try {
        saved = await insertGovCopayRow(tx, {
          code: code ?? 'thai_chuay_thai_plus',
          nameTh: nameTh as string,
          nameEn: nameEn ?? null,
          settlementNote: settlementNote ?? null,
          ...scheme,
        });
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        if (cause?.code === '23505') throw versionConflict(1); // created by someone else just now
        throw error;
      }
      await audit(tx, actor, meta, saved.id, null, { created: true, ...fieldsOf(saved) });
    }
    emit(
      securityAlert(ctx, 'settings.gov_copay_changed', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
      }),
    );
    emit({
      type: 'settings.updated',
      key: 'gov_copay',
      rev: saved.rev,
      version: saved.version,
      data: toDto(saved),
    });
    return { scheme: toDto(saved) };
  });
}

async function audit(
  tx: Db,
  actor: Principal,
  meta: RequestMeta,
  schemeId: string,
  before: unknown,
  after: unknown,
) {
  await insertAudit(tx, {
    actorType: 'staff',
    actorId: actor.staffId,
    deviceId: actor.deviceId,
    action: 'settings.gov_copay_change',
    entity: 'gov_copay_schemes',
    entityId: schemeId,
    before,
    after,
    ip: meta.ip,
  });
}
