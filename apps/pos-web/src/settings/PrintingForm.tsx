import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard, SwitchRow } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { PrintJobsList } from './PrintJobsList.tsx';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/**
 * Whether new orders are sent to the print notebook, with plain words about what the switch does,
 * and below it the recent print jobs. The switch is saved with the Save button like every setting.
 */
export function PrintingForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'printing'>) {
  const tr = useT();
  const [enabled, setEnabled] = useState(loaded.value.enabled);

  return (
    <div style={s('display:flex;flex-direction:column;gap:18px')}>
      <form
        style={s('display:flex;flex-direction:column;gap:18px')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(
            enabled === loaded.value.enabled ? null : { expectedVersion: loaded.version, enabled },
          );
        }}
      >
        <FormCard>
          <SwitchRow
            label={tr('settings.printing.switch')}
            hint={tr('settings.printing.switchHint')}
            checked={enabled}
            disabled={!editable}
            onChange={setEnabled}
          />
          <p className="g-t-s" style={s('margin:0;font-weight:500')} aria-live="polite">
            {tr(loaded.value.enabled ? 'settings.printing.stateOn' : 'settings.printing.stateOff')}
          </p>
          <ul
            className="g-t-s"
            style={s('margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px')}
          >
            <li>{tr('settings.printing.explainOff')}</li>
            <li>{tr('settings.printing.explainReprint')}</li>
            <li>{tr('settings.printing.explainShutdown')}</li>
          </ul>
        </FormCard>
        <SaveBar editable={editable} busy={busy} saving={saving} />
      </form>
      <PrintJobsList />
    </div>
  );
}
