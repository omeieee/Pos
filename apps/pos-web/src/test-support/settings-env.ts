/**
 * A fake settings API for the screen tests: every resource's `read` and `save` fail the test unless
 * the test gave it an answer. The shared answers below are made up (no real ID, no real phone).
 */
import {
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
} from '@sds/shared';
import { vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';

type Settings = ApiClient['settings'];
export type FakeResource = { read: (...a: never[]) => unknown; save: (...a: never[]) => unknown };
export type SettingsOverrides = {
  [K in 'shop' | 'openingHours' | 'numbering' | 'payments' | 'deliveryList']?: Partial<Settings[K]>;
};

const NOW = '2026-10-03T03:00:00.000Z';

/** A GET/PATCH answer for a setting at a version. */
export const settingAnswer = <V>(value: V, version = 1) => ({
  value,
  version,
  rev: version * 10,
  updatedAt: NOW,
});

/** What each resource reads when the test says nothing: the shared defaults at version 0. */
const DEFAULT_READS = {
  shop: DEFAULT_SHOP_SETTINGS,
  openingHours: DEFAULT_OPENING_HOURS,
  numbering: { cutoffMinutes: 240, timeZone: 'Asia/Bangkok' },
  payments: { cash: true, promptpay: true, platform: true, other: false },
  deliveryList: DEFAULT_DELIVERY_SETTINGS,
} as const;

export function createFakeSettingsApi(overrides: SettingsOverrides = {}) {
  const out: Record<string, { read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }> =
    {};
  for (const name of Object.keys(DEFAULT_READS) as (keyof typeof DEFAULT_READS)[]) {
    const given = overrides[name] as Partial<FakeResource> | undefined;
    out[name] = {
      read: vi.fn(
        (given?.read as (() => unknown) | undefined) ??
          (async () => settingAnswer(DEFAULT_READS[name], 0)),
      ),
      save: vi.fn(
        (given?.save as (() => unknown) | undefined) ??
          (async () => {
            throw new Error(`settings.${name}.save was not expected`);
          }),
      ),
    };
  }
  return out as {
    [K in keyof typeof DEFAULT_READS]: {
      read: ReturnType<typeof vi.fn<Settings[K]['read']>>;
      save: ReturnType<typeof vi.fn<Settings[K]['save']>>;
    };
  };
}
