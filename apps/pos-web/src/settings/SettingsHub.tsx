import { useAuthState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { hubEntries, MENU_PATH, sectionPath, showsMenuLink } from './sections.ts';

/**
 * The Settings page: one card per section the person may open, plus the menu editor when they may
 * edit the menu. A card says when the section is view-only for this person, or asks to confirm
 * who they are first (devices and staff). Hiding a card is a convenience: the API checks every call.
 */
export function SettingsHub() {
  const tr = useT();
  const permissions = useAuthState().session?.permissions ?? [];
  const entries = hubEntries(permissions);

  return (
    <section className="sset" aria-labelledby="sset-title">
      <header className="sset__head">
        <h1 id="sset-title" className="sset__title">
          {tr('settings.title')}
        </h1>
        <p className="muted">{tr('settings.hub.intro')}</p>
      </header>
      <ul className="sset__cards">
        {showsMenuLink(permissions) ? (
          <li>
            <a className="sset__card" href={`#${MENU_PATH}`}>
              <span className="sset__card-title">{tr('settings.menu.title')}</span>
              <span className="muted">{tr('settings.menu.desc')}</span>
            </a>
          </li>
        ) : null}
        {entries.map(({ section, canEdit }) => (
          <li key={section.id}>
            <a className="sset__card" href={`#${sectionPath(section.id)}`}>
              <span className="sset__card-title">{tr(section.titleKey)}</span>
              <span className="muted">{tr(section.descKey)}</span>
              {canEdit ? null : <span className="tag">{tr('settings.hub.readOnly')}</span>}
              {section.stepUpToOpen ? (
                <span className="sset__card-note">
                  <Icon name="info" />
                  {tr('settings.hub.needsConfirm')}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
