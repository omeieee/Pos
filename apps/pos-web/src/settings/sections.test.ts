import { ROLE_PERMISSIONS, type StaffRole } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  hubEntries,
  SECTION_IDS,
  SECTIONS,
  sectionById,
  sectionPath,
  showsMenuLink,
} from './sections.ts';

const permissionsOf = (role: StaffRole) => [...ROLE_PERMISSIONS[role]];
const idsFor = (role: StaffRole) => hubEntries(permissionsOf(role)).map((e) => e.section.id);

describe('who sees which card', () => {
  test('the owner sees every section and may change every one', () => {
    const entries = hubEntries(permissionsOf('owner'));
    expect(entries.map((e) => e.section.id)).toEqual([...SECTION_IDS]);
    expect(entries.every((e) => e.canEdit)).toBe(true);
  });

  test('a manager changes the shop settings but may only look at PromptPay and the co-pay scheme, and has no devices or staff', () => {
    const entries = hubEntries(permissionsOf('manager'));
    const byId = Object.fromEntries(entries.map((e) => [e.section.id, e.canEdit]));
    expect(byId).toEqual({
      shop: true,
      hours: true,
      numbering: true,
      payments: true,
      delivery: true,
      'line-ordering': true,
      promptpay: false,
      'gov-copay': false,
    });
  });

  test('a cashier may look at the settings it needs, but change nothing', () => {
    const entries = hubEntries(permissionsOf('cashier'));
    expect(entries.map((e) => e.section.id)).not.toContain('devices');
    expect(entries.map((e) => e.section.id)).not.toContain('staff');
    expect(entries.length).toBe(8);
    expect(entries.some((e) => e.canEdit)).toBe(false);
  });

  test('the kitchen sees nothing', () => {
    expect(idsFor('kitchen')).toEqual([]);
  });

  test('the menu link follows menu.edit alone', () => {
    expect(showsMenuLink(permissionsOf('manager'))).toBe(true);
    expect(showsMenuLink(permissionsOf('owner'))).toBe(true);
    expect(showsMenuLink(permissionsOf('cashier'))).toBe(false);
    expect(showsMenuLink(['settings.view'])).toBe(false);
  });
});

describe('the table', () => {
  test('every section has a unique id, a path and the permission the API checks', () => {
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    expect(sectionPath('gov-copay')).toBe('/settings/gov-copay');
    expect(sectionById('promptpay')).toMatchObject({
      view: 'settings.view',
      edit: 'settings.promptpay',
    });
    expect(sectionById('gov-copay')?.edit).toBe('settings.gov_copay');
    expect(sectionById('devices')).toMatchObject({ view: 'device.manage', stepUpToOpen: true });
    expect(sectionById('staff')).toMatchObject({ view: 'staff.manage', stepUpToOpen: true });
  });

  test('menu is not a section: it has its own page', () => {
    expect(sectionById('menu')).toBeUndefined();
  });
});
