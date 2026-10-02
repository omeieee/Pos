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
import type { Permission } from '@sds/shared';
import {
  businessDaySettingsSchema,
  DEFAULT_CUTOFF_MINUTES,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
  type GovCopayDto,
  type GovCopayResponse,
  govCopayDtoSchema,
  govCopayPatchInputSchema,
  govCopaySchemeSchema,
  maskPromptpayId,
  numberingPatchInputSchema,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  type PromptpaySettings,
  paymentsPatchInputSchema,
  paymentsSettingsSchema,
  promptpayPatchInputSchema,
  promptpaySettingsSchema,
  SHOP_TIME_ZONE,
  shopPatchInputSchema,
  shopSettingsSchema,
} from '@sds/shared';
import type { z } from 'zod';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { ApiError, versionConflict } from '../errors.ts';
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
    // The business day and the order numbering that restarts with it (03 §5).
    route: 'numbering',
    key: 'business_day',
    schema: businessDaySettingsSchema,
    defaults: businessDayDefaults,
    patch: numberingPatchInputSchema,
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
    route: 'promptpay',
    key: 'promptpay',
    schema: promptpaySettingsSchema,
    defaults: null,
    patch: promptpayPatchInputSchema,
    editPermission: 'settings.promptpay',
    promptpay: true,
  },
];

export interface SettingResponse {
  value: unknown;
  version: number;
  rev: number;
  updatedAt: string | null;
}

function toResponse(resource: Resource, row: SettingRow | undefined): SettingResponse {
  if (!row) return { value: resource.defaults, version: 0, rev: 0, updatedAt: null };
  return {
    value: resource.schema.parse(row.value),
    version: row.version,
    rev: row.rev,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readSetting(ctx: AuthContext, resource: Resource): Promise<SettingResponse> {
  return toResponse(resource, await getSettingRow(ctx.db, resource.key));
}

/** The PromptPay ID the QR must use right now, read from settings every time (rule 3). */
export async function currentPromptpayId(db: Db): Promise<PromptpaySettings | null> {
  const row = await getSettingRow(db, 'promptpay');
  return row ? promptpaySettingsSchema.parse(row.value) : null;
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

const maskedPromptpay = (value: PromptpaySettings | null) =>
  value ? { idType: value.idType, idMasked: maskPromptpayId(value.idValue) } : null;

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
    if (row && same(current, next)) return toResponse(resource, row); // nothing to change

    const saved = row
      ? await updateSettingRowIfVersion(tx, resource.key, version, next, actor.staffId)
      : await insertSettingRow(tx, resource.key, next, actor.staffId);
    if (!saved) throw versionConflict(version + 1); // another request created or changed it first

    // Warn, do not cancel (owner, 2026-10-02): a count of PromptPay payments still open under the
    // old ID goes to the audit row and the alert, so the owner can check them. Never an ID.
    const openPromptpay = resource.promptpay
      ? await paymentsRepo.countOpenByMethod(tx, 'promptpay')
      : 0;
    const view = resource.promptpay
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
      action: resource.promptpay ? 'settings.promptpay_change' : 'settings.update',
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
    emit({
      type: 'settings.updated',
      key: resource.key,
      rev: saved.rev,
      version: saved.version,
      // The ID itself never rides an event (the fan-out would carry it to every device); a device
      // that needs it reads GET /v1/settings/promptpay, which needs `settings.view`.
      data: resource.promptpay ? maskedPromptpay(next as PromptpaySettings) : next,
    });
    return toResponse(resource, saved);
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
