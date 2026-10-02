import { useAuthState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { DeliveryForm } from './DeliveryForm.tsx';
import { HoursForm } from './HoursForm.tsx';
import { NumberingForm } from './NumberingForm.tsx';
import { PaymentsForm } from './PaymentsForm.tsx';
import { SettingSection } from './SettingSection.tsx';
import { ShopForm } from './ShopForm.tsx';
import { type SectionDef, sectionById } from './sections.ts';

function BackLink() {
  const tr = useT();
  return (
    <a className="btn btn-soft sset__back" href="#/settings">
      <Icon name="back" />
      <span>{tr('settings.back')}</span>
    </a>
  );
}

/** What a section shows. Each section's screen is added as it is built. */
function SectionBody({ def, editable }: { def: SectionDef; editable: boolean }) {
  const tr = useT();
  switch (def.id) {
    case 'shop':
      return (
        <SettingSection name="shop" editable={editable}>
          {(p) => <ShopForm {...p} />}
        </SettingSection>
      );
    case 'hours':
      return (
        <SettingSection name="hours" editable={editable}>
          {(p) => <HoursForm {...p} />}
        </SettingSection>
      );
    case 'numbering':
      return (
        <SettingSection name="numbering" editable={editable}>
          {(p) => <NumberingForm {...p} />}
        </SettingSection>
      );
    case 'payments':
      return (
        <SettingSection name="payments" editable={editable}>
          {(p) => <PaymentsForm {...p} />}
        </SettingSection>
      );
    case 'delivery':
      return (
        <SettingSection name="delivery" editable={editable}>
          {(p) => <DeliveryForm {...p} />}
        </SettingSection>
      );
    default:
      return <p className="muted">{tr('settings.soon')}</p>;
  }
}

/**
 * One page of Settings (`#/settings/<section>`). A name that is not a section (the menu editor
 * has its own page) or one the person may not open shows "not found" with a way back, and never
 * renders another screen: the address bar is not an authorisation.
 */
export function SettingsSectionScreen({ section }: { section: string }) {
  const tr = useT();
  const permissions = useAuthState().session?.permissions ?? [];
  const def = sectionById(section);

  if (!def || !permissions.includes(def.view)) {
    return (
      <section className="sset" aria-labelledby="sset-title">
        <BackLink />
        <h1 id="sset-title" className="sset__title">
          {tr('settings.title')}
        </h1>
        <p className="notice" role="status">
          <Icon name="info" />
          <span>{tr('settings.notFound')}</span>
        </p>
      </section>
    );
  }

  return (
    <section className="sset" aria-labelledby="sset-title">
      <BackLink />
      <header className="sset__head">
        <h1 id="sset-title" className="sset__title">
          {tr(def.titleKey)}
        </h1>
        <p className="muted">{tr(def.descKey)}</p>
      </header>
      <SectionBody def={def} editable={permissions.includes(def.edit)} />
    </section>
  );
}
