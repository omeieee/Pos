/**
 * The sections of Settings and who may open and change each one. The permission names come from
 * `@sds/shared` and match what the API checks on the same route (`apps/api/src/settings/routes.ts`,
 * `admin/routes.ts`): hiding a card is only a convenience, the API refuses the rest.
 *
 * The menu editor is not a section here: it has its own page (`#/settings/menu`, `menu.edit`) and
 * the hub links to it.
 */
import type { MessageKey } from '@sds/i18n';
import type { Permission } from '@sds/shared';

export const SECTION_IDS = [
  'shop',
  'hours',
  'numbering',
  'payments',
  'delivery',
  'promptpay',
  'gov-copay',
  'devices',
  'staff',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionDef {
  id: SectionId;
  titleKey: MessageKey;
  descKey: MessageKey;
  /** Who may open it (read it). */
  view: Permission;
  /** Who may change it. Equal to `view` when the screen has no read-only form (devices, staff). */
  edit: Permission;
  /** Opening the section already needs a fresh step-up (the API asks for it on the list). */
  stepUpToOpen: boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  {
    id: 'shop',
    titleKey: 'settings.shop.title',
    descKey: 'settings.shop.desc',
    view: 'settings.view',
    edit: 'settings.edit',
    stepUpToOpen: false,
  },
  {
    id: 'hours',
    titleKey: 'settings.hours.title',
    descKey: 'settings.hours.desc',
    view: 'settings.view',
    edit: 'settings.edit',
    stepUpToOpen: false,
  },
  {
    id: 'numbering',
    titleKey: 'settings.numbering.title',
    descKey: 'settings.numbering.desc',
    view: 'settings.view',
    edit: 'settings.edit',
    stepUpToOpen: false,
  },
  {
    id: 'payments',
    titleKey: 'settings.payments.title',
    descKey: 'settings.payments.desc',
    view: 'settings.view',
    edit: 'settings.edit',
    stepUpToOpen: false,
  },
  {
    id: 'delivery',
    titleKey: 'settings.delivery.title',
    descKey: 'settings.delivery.desc',
    view: 'settings.view',
    edit: 'settings.edit',
    stepUpToOpen: false,
  },
  {
    id: 'promptpay',
    titleKey: 'settings.promptpay.title',
    descKey: 'settings.promptpay.desc',
    view: 'settings.view',
    edit: 'settings.promptpay',
    stepUpToOpen: false,
  },
  {
    id: 'gov-copay',
    titleKey: 'settings.copay.title',
    descKey: 'settings.copay.desc',
    view: 'settings.view',
    edit: 'settings.gov_copay',
    stepUpToOpen: false,
  },
  {
    id: 'devices',
    titleKey: 'settings.devices.title',
    descKey: 'settings.devices.desc',
    view: 'device.manage',
    edit: 'device.manage',
    stepUpToOpen: true,
  },
  {
    id: 'staff',
    titleKey: 'settings.staff.title',
    descKey: 'settings.staff.desc',
    view: 'staff.manage',
    edit: 'staff.manage',
    stepUpToOpen: true,
  },
];

export const sectionById = (id: string): SectionDef | undefined =>
  SECTIONS.find((section) => section.id === id);

/** The path of a section's page (without the `#`). */
export const sectionPath = (id: SectionId): string => `/settings/${id}`;

export const MENU_PATH = '/settings/menu';

export interface HubEntry {
  section: SectionDef;
  canEdit: boolean;
}

/** The cards of the hub for these permissions, in order. */
export function hubEntries(permissions: readonly Permission[]): HubEntry[] {
  return SECTIONS.filter((section) => permissions.includes(section.view)).map((section) => ({
    section,
    canEdit: permissions.includes(section.edit),
  }));
}

/** Does the hub link to the menu editor for these permissions? */
export const showsMenuLink = (permissions: readonly Permission[]): boolean =>
  permissions.includes('menu.edit');
