import { describe, expect, test } from 'vitest';
import { enAuth } from './en/auth.ts';
import { enCommon } from './en/common.ts';
import { enErrors } from './en/errors.ts';
import { enFinance } from './en/finance.ts';
import { enLiff } from './en/liff.ts';
import { enLine } from './en/line.ts';
import { enMenuEditor } from './en/menu-editor.ts';
import { enOrders } from './en/orders.ts';
import { enPayment } from './en/payment.ts';
import { enPos } from './en/pos.ts';
import { enReports } from './en/reports.ts';
import { enSettings } from './en/settings.ts';
import { enSettingsAccess } from './en/settings-access.ts';
import { enSettingsPayments } from './en/settings-payments.ts';
import { enShell } from './en/shell.ts';
import { en } from './en.ts';
import { thAuth } from './th/auth.ts';
import { thCommon } from './th/common.ts';
import { thErrors } from './th/errors.ts';
import { thFinance } from './th/finance.ts';
import { thLiff } from './th/liff.ts';
import { thLine } from './th/line.ts';
import { thMenuEditor } from './th/menu-editor.ts';
import { thOrders } from './th/orders.ts';
import { thPayment } from './th/payment.ts';
import { thPos } from './th/pos.ts';
import { thReports } from './th/reports.ts';
import { thSettings } from './th/settings.ts';
import { thSettingsAccess } from './th/settings-access.ts';
import { thSettingsPayments } from './th/settings-payments.ts';
import { thShell } from './th/shell.ts';
import { th } from './th.ts';

/**
 * `th` and `en` are built by spreading one object per feature (src/th/*.ts, src/en/*.ts). A spread
 * lets a later part silently replace an earlier one, and does not flag an extra key, so these tests
 * stand in for the compile-time checks a single flat object gave. A new part must be added here
 * too: the last test fails when the parts listed here do not add up to the assembled catalog.
 */
const thParts: Record<string, Record<string, string>> = {
  auth: thAuth,
  common: thCommon,
  errors: thErrors,
  finance: thFinance,
  liff: thLiff,
  line: thLine,
  'menu-editor': thMenuEditor,
  orders: thOrders,
  payment: thPayment,
  pos: thPos,
  reports: thReports,
  settings: thSettings,
  'settings-access': thSettingsAccess,
  'settings-payments': thSettingsPayments,
  shell: thShell,
};
const enParts: Record<string, Record<string, string>> = {
  auth: enAuth,
  common: enCommon,
  errors: enErrors,
  finance: enFinance,
  liff: enLiff,
  line: enLine,
  'menu-editor': enMenuEditor,
  orders: enOrders,
  payment: enPayment,
  pos: enPos,
  reports: enReports,
  settings: enSettings,
  'settings-access': enSettingsAccess,
  'settings-payments': enSettingsPayments,
  shell: enShell,
};

const firstOwners = (parts: Record<string, Record<string, string>>) => {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [name, catalog] of Object.entries(parts)) {
    for (const key of Object.keys(catalog)) {
      const owner = seen.get(key);
      if (owner !== undefined) clashes.push(`${key} is in both ${owner} and ${name}`);
      seen.set(key, name);
    }
  }
  return clashes;
};

describe('catalog parts', () => {
  test('no key is defined in two th parts', () => {
    expect(firstOwners(thParts)).toEqual([]);
  });

  test('no key is defined in two en parts', () => {
    expect(firstOwners(enParts)).toEqual([]);
  });

  test('each en part has exactly the keys of its th part', () => {
    expect(Object.keys(enParts).sort()).toEqual(Object.keys(thParts).sort());
    for (const [name, catalog] of Object.entries(thParts)) {
      expect(Object.keys(enParts[name] ?? {}).sort(), name).toEqual(Object.keys(catalog).sort());
    }
  });

  test('the parts listed here add up to the assembled catalogs', () => {
    const total = (parts: Record<string, Record<string, string>>) =>
      Object.values(parts).reduce((sum, catalog) => sum + Object.keys(catalog).length, 0);
    expect(Object.keys(th).length).toBe(total(thParts));
    expect(Object.keys(en).length).toBe(total(enParts));
  });
});
