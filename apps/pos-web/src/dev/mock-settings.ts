/**
 * The shop, opening-hours, numbering and delivery settings routes of the dev shop
 * (`VITE_MOCK_API=1`) and of tests, answering the way apps/api does: reads need `settings.view`,
 * changes need `settings.edit`, a change names the version it was built on (409 VERSION_CONFLICT
 * with the current one), the shared patch schemas validate every body, a never-saved setting reads
 * as its default at version 0, and a saved one reaches every open socket as a `settings.updated`
 * frame. Everything here is made up and nothing is persisted.
 *
 * Not modelled: the delivery list does not change which buildings the mock's order screen accepts
 * (the order routes in mock-shop.ts keep their own list).
 */
import {
  type BusinessDaySettings,
  businessDaySettingsSchema,
  DEFAULT_CUTOFF_MINUTES,
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
  deliveryPatchInputSchema,
  deliverySettingsSchema,
  numberingPatchInputSchema,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  type RealtimeFrame,
  ROLE_PERMISSIONS,
  SHOP_TIME_ZONE,
  shopPatchInputSchema,
  shopSettingsSchema,
} from '@sds/shared';
import type { z } from 'zod';
import type { MockAnswer, MockCaller } from './mock-payments.ts';

interface Deps {
  now: () => number;
  nextRev: () => number;
  publish: (frame: RealtimeFrame & { rev: number }) => void;
}

interface Resource {
  /** The path segment under /v1/settings. */
  route: string;
  /** The key the frame travels under. */
  key: string;
  schema: z.ZodType;
  patch: z.ZodType;
  defaults: unknown;
  /** The change also answers PUT (the delivery list). */
  put?: true;
}

const businessDayDefaults: BusinessDaySettings = {
  cutoffMinutes: DEFAULT_CUTOFF_MINUTES,
  timeZone: SHOP_TIME_ZONE,
};

const RESOURCES: readonly Resource[] = [
  {
    route: 'shop',
    key: 'shop',
    schema: shopSettingsSchema,
    patch: shopPatchInputSchema,
    defaults: DEFAULT_SHOP_SETTINGS,
  },
  {
    route: 'opening-hours',
    key: 'opening_hours',
    schema: openingHoursSchema,
    patch: openingHoursPatchInputSchema,
    defaults: DEFAULT_OPENING_HOURS,
  },
  {
    route: 'numbering',
    key: 'business_day',
    schema: businessDaySettingsSchema,
    patch: numberingPatchInputSchema,
    defaults: businessDayDefaults,
  },
  {
    route: 'delivery',
    key: 'delivery',
    schema: deliverySettingsSchema,
    patch: deliveryPatchInputSchema,
    defaults: DEFAULT_DELIVERY_SETTINGS,
    put: true,
  },
];

const error = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details },
});

interface Saved {
  value: unknown;
  version: number;
  rev: number;
  updatedAt: string;
}

export function createMockSettings(deps: Deps) {
  const saved = new Map<string, Saved>();

  const respond = (resource: Resource): MockAnswer => {
    const row = saved.get(resource.key);
    return {
      status: 200,
      body: row
        ? { value: row.value, version: row.version, rev: row.rev, updatedAt: row.updatedAt }
        : { value: resource.defaults, version: 0, rev: 0, updatedAt: null },
    };
  };

  function change(resource: Resource, body: unknown): MockAnswer {
    const input = resource.patch.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const { expectedVersion, ...fields } = input.data as { expectedVersion: number };
    const row = saved.get(resource.key);
    const version = row?.version ?? 0;
    if (expectedVersion !== version)
      return error(409, 'VERSION_CONFLICT', { currentVersion: version });
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const next = resource.schema.safeParse({
      ...((row?.value ?? resource.defaults) as object),
      ...given,
    });
    if (!next.success) return error(400, 'VALIDATION_ERROR');
    if (row && JSON.stringify(row.value) === JSON.stringify(next.data)) return respond(resource);
    const rev = deps.nextRev();
    const updated: Saved = {
      value: next.data,
      version: version + 1,
      rev,
      updatedAt: new Date(deps.now()).toISOString(),
    };
    saved.set(resource.key, updated);
    deps.publish({
      type: 'settings.updated',
      id: resource.key,
      rev,
      version: updated.version,
      data: updated.value,
    } as RealtimeFrame & { rev: number });
    return respond(resource);
  }

  /** Answers the routes of these settings (null: not one of them). */
  function handle(
    method: string,
    path: string,
    body: unknown,
    caller: MockCaller,
  ): MockAnswer | null {
    const resource = RESOURCES.find((r) => path === `/v1/settings/${r.route}`);
    if (!resource) return null;
    const permissions = ROLE_PERMISSIONS[caller.role];
    if (method === 'GET') {
      return permissions.has('settings.view') ? respond(resource) : error(403, 'FORBIDDEN');
    }
    if (method === 'PATCH' || (method === 'PUT' && resource.put)) {
      return permissions.has('settings.edit') ? change(resource, body) : error(403, 'FORBIDDEN');
    }
    return null;
  }

  return { handle };
}
