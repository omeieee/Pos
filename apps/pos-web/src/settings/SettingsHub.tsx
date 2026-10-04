import type { MessageKey } from '@sds/i18n';
import { useState } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { AccountMenu } from '../ui/AccountMenu.tsx';
import { useAuthState, useT } from '../ui/hooks.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { hubEntries, MENU_PATH, type SectionId, sectionPath, showsMenuLink } from './sections.ts';

/** The icon chip of each row: the canvas icon and its colour (iphone-settings). */
const CHIP: Record<SectionId | 'menu', { icon: GiName; color: string }> = {
  menu: { icon: 'bowl', color: '#c62828' },
  shop: { icon: 'shop', color: '#d63a2e' },
  hours: { icon: 'clock', color: '#5b6fd6' },
  numbering: { icon: 'receipt', color: '#7a5af5' },
  delivery: { icon: 'building', color: '#c7691a' },
  payments: { icon: 'cash', color: '#1b7a43' },
  promptpay: { icon: 'qr', color: '#2457b8' },
  'gov-copay': { icon: 'bank', color: '#c7691a' },
  devices: { icon: 'monitor', color: '#3a3330' },
  staff: { icon: 'people', color: '#1b7a43' },
};

/** The groups of the hub, in the order of the design. */
const GROUPS: readonly {
  id: string;
  titleKey: MessageKey;
  rows: readonly (SectionId | 'menu')[];
}[] = [
  {
    id: 'shop',
    titleKey: 'settings.group.shop',
    rows: ['menu', 'shop', 'hours', 'numbering', 'delivery'],
  },
  {
    id: 'payments',
    titleKey: 'settings.group.payments',
    rows: ['payments', 'promptpay', 'gov-copay'],
  },
  { id: 'people', titleKey: 'settings.group.people', rows: ['devices', 'staff'] },
];

/** Rows the design draws that the app has no feature for yet: shown, switched off. */
const DESIGN_ONLY = [
  {
    id: 'sound',
    titleKey: 'settings.notify.sound',
    descKey: null,
    icon: 'bell',
    color: '#d63a2e',
    on: true,
  },
  {
    id: 'mobile',
    titleKey: 'settings.notify.mobile',
    descKey: 'settings.notify.mobileDesc',
    icon: 'phone',
    color: '#7a5af5',
    on: false,
  },
] as const satisfies readonly {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey | null;
  icon: GiName;
  color: string;
  on: boolean;
}[];

function Chip({ id }: { id: SectionId | 'menu' }) {
  const chip = CHIP[id];
  return (
    <div className="g-ico" style={s(`background:${chip.color}`)}>
      <Gi n={chip.icon} size="sm" />
    </div>
  );
}

const initial = (name: string) => Array.from(name.trim())[0] ?? '';

/**
 * The Settings page (design: iphone-settings): a title, a search box, the signed-in person's row
 * (it opens the account menu with sign-out and the device), then one glass list per group with an
 * icon chip on every row. The rows are the app's real sections: only those the person may open
 * are listed, a row says when it is view-only for them or asks to confirm who they are first
 * (devices and staff). Hiding a row is a convenience: the API checks every call. The notification
 * rows are in the design but have no feature yet, so they are shown switched off.
 */
export function SettingsHub() {
  const tr = useT();
  const state = useAuthState();
  const permissions = state.session?.permissions ?? [];
  const entries = new Map(hubEntries(permissions).map((entry) => [entry.section.id, entry]));
  const withMenu = showsMenuLink(permissions);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | null)[]) =>
    needle === '' || texts.some((text) => text?.toLowerCase().includes(needle));

  const staff = state.session?.staff;
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: group.rows.filter((id) => {
      if (id === 'menu')
        return withMenu && matches(tr('settings.menu.title'), tr('settings.menu.desc'));
      const entry = entries.get(id);
      return entry !== undefined && matches(tr(entry.section.titleKey), tr(entry.section.descKey));
    }),
  }));
  // The notification rows sit between payments and devices, as in the design.
  const notify = DESIGN_ONLY.filter((row) =>
    matches(tr(row.titleKey), row.descKey ? tr(row.descKey) : null),
  );
  const blocks = [
    ...groups
      .filter((group) => group.id !== 'people' && group.rows.length > 0)
      .map((group) => ({ kind: 'sections' as const, ...group })),
    ...(notify.length > 0
      ? [
          {
            kind: 'design' as const,
            id: 'notify',
            titleKey: 'settings.group.notify' as const,
            rows: notify,
          },
        ]
      : []),
    ...groups
      .filter((group) => group.id === 'people' && group.rows.length > 0)
      .map((group) => ({ kind: 'sections' as const, ...group })),
  ];
  const nothing = blocks.length === 0;

  function renderRow(id: SectionId | 'menu') {
    if (id === 'menu') {
      return (
        <a key={id} className="g-row" href={`#${MENU_PATH}`}>
          <Chip id={id} />
          <div style={s('flex-grow:1;min-width:0')}>
            <div className="g-t-3" style={s('font-weight:500')}>
              {tr('settings.menu.title')}
            </div>
            <div className="g-t-c gset-oneline">{tr('settings.menu.desc')}</div>
          </div>
          <Gi n="chevronRight" className="gset-chev" />
        </a>
      );
    }
    const entry = entries.get(id);
    if (!entry) return null;
    const { section, canEdit } = entry;
    return (
      <a key={id} className="g-row" href={`#${sectionPath(section.id)}`}>
        <Chip id={id} />
        <div style={s('flex-grow:1;min-width:0')}>
          <div className="g-t-3" style={s('font-weight:500')}>
            {tr(section.titleKey)}
          </div>
          <div className="g-t-c gset-oneline">{tr(section.descKey)}</div>
          {section.stepUpToOpen ? (
            <div className="g-t-c" style={s('display:flex;align-items:center;gap:5px')}>
              <Gi n="lock" style={s('width:13px;height:13px')} />
              <span>{tr('settings.hub.needsConfirm')}</span>
            </div>
          ) : null}
        </div>
        {canEdit ? null : (
          <span className="g-badge g-b-mute">
            <Gi n="eye" />
            {tr('settings.hub.readOnly')}
          </span>
        )}
        <Gi n="chevronRight" className="gset-chev" />
      </a>
    );
  }

  return (
    <SettingsPage labelledBy="sset-title">
      <header className="gset-head">
        <h1 id="sset-title" className="g-t-1" style={s('margin:0')}>
          {tr('settings.title')}
        </h1>
        <label className="g-field gset-search">
          <Gi n="search" />
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label={tr('settings.hub.search')}
            placeholder={tr('settings.hub.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>

      {staff && needle === '' ? (
        <div className="g-rise" style={s('--d:.03s;position:relative;z-index:5')}>
          <AccountMenu
            placement="bottom"
            label={tr('settings.hub.profile')}
            className="g-glass"
            style={s(
              'width:100%;border-radius:28px;padding:14px 16px;display:flex;align-items:center;gap:14px;text-align:left;font:inherit;color:inherit;cursor:pointer',
            )}
          >
            <span className="g-avatar" style={s('width:52px;height:52px;font-size:20px')}>
              {initial(staff.displayName)}
            </span>
            <span style={s('flex-grow:1;min-width:0;display:block')}>
              <span className="g-t-2" style={s('display:block;overflow-wrap:anywhere')}>
                {staff.displayName}
              </span>
              <span className="g-t-c" style={s('display:block')}>
                {tr(`role.${staff.role}`)}
                {state.device ? ` · ${state.device.name}` : ''}
              </span>
            </span>
            <Gi n="chevronRight" className="gset-chev" />
          </AccountMenu>
        </div>
      ) : null}

      {blocks.map((block, index) => (
        <div key={block.id} className="g-rise" style={s(`--d:${0.07 + index * 0.04}s`)}>
          <div className="gset-lbl">{tr(block.titleKey)}</div>
          <div className="g-glass gset-grp">
            {block.kind === 'sections'
              ? block.rows.map(renderRow)
              : block.rows.map((row) => (
                  <div key={row.id} className="g-row g-row--off" title={tr('nav.notReady')}>
                    <div className="g-ico" style={s(`background:${row.color}`)}>
                      <Gi n={row.icon} size="sm" />
                    </div>
                    <div style={s('flex-grow:1;min-width:0')}>
                      <div className="g-t-3" style={s('font-weight:500')}>
                        {tr(row.titleKey)}
                      </div>
                      {row.descKey ? (
                        <div className="g-t-c gset-oneline">{tr(row.descKey)}</div>
                      ) : null}
                    </div>
                    <input
                      type="checkbox"
                      className="g-sw"
                      checked={row.on}
                      disabled
                      readOnly
                      aria-disabled="true"
                      aria-label={tr(row.titleKey)}
                      title={tr('nav.notReady')}
                    />
                  </div>
                ))}
          </div>
        </div>
      ))}

      {nothing ? (
        <p className="g-t-s" role="status" style={s('margin:0;text-align:center;padding:24px 0')}>
          {tr('settings.hub.noMatch')}
        </p>
      ) : null}
    </SettingsPage>
  );
}
