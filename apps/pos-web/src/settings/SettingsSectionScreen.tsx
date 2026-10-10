import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useAuthState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { CopayForm } from './CopayForm.tsx';
import { DeliveryForm } from './DeliveryForm.tsx';
import { DevicesScreen } from './DevicesScreen.tsx';
import { HoursForm } from './HoursForm.tsx';
import { LineOrderingForm } from './LineOrderingForm.tsx';
import { NumberingForm } from './NumberingForm.tsx';
import { PaymentsForm } from './PaymentsForm.tsx';
import { PromptpayForm } from './PromptpayForm.tsx';
import { SettingSection } from './SettingSection.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { ShopForm } from './ShopForm.tsx';
import { StaffScreen } from './StaffScreen.tsx';
import { type SectionDef, sectionById } from './sections.ts';

function BackLink() {
  const tr = useT();
  return (
    <a className="g-btn gset-back" href="#/settings">
      <Gi n="chevronLeft" size="sm" />
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
    case 'line-ordering':
      return (
        <SettingSection name="lineOrdering" editable={editable}>
          {(p) => <LineOrderingForm {...p} />}
        </SettingSection>
      );
    case 'promptpay':
      return (
        <SettingSection name="promptpay" editable={editable}>
          {(p) => <PromptpayForm {...p} />}
        </SettingSection>
      );
    case 'gov-copay':
      return (
        <SettingSection name="copay" editable={editable}>
          {(p) => <CopayForm {...p} />}
        </SettingSection>
      );
    case 'devices':
      return <DevicesScreen />;
    case 'staff':
      return <StaffScreen />;
    default:
      return <p className="g-t-s">{tr('settings.soon')}</p>;
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
      <SettingsPage labelledBy="sset-title">
        <BackLink />
        <h1 id="sset-title" className="g-t-1" style={s('margin:0')}>
          {tr('settings.title')}
        </h1>
        <Callout tone="info" role="status">
          {tr('settings.notFound')}
        </Callout>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage labelledBy="sset-title">
      <BackLink />
      <header>
        <h1 id="sset-title" className="g-t-1" style={s('margin:0')}>
          {tr(def.titleKey)}
        </h1>
        <p className="g-t-s" style={s('margin:2px 0 0')}>
          {tr(def.descKey)}
        </p>
      </header>
      <SectionBody def={def} editable={permissions.includes(def.edit)} />
    </SettingsPage>
  );
}
