import { LINE_ORDERING_MODES, type LineOrderingMode } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard, SegRadio } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/** Whether customers can order in LINE: any time, never, or by the delivery hours. */
export function LineOrderingForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'lineOrdering'>) {
  const tr = useT();
  const [mode, setMode] = useState<LineOrderingMode>(loaded.value.mode);

  return (
    <form
      style={s('display:flex;flex-direction:column;gap:18px')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(mode === loaded.value.mode ? null : { expectedVersion: loaded.version, mode });
      }}
    >
      <FormCard>
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.lineOrdering.hint')}
        </p>
        <SegRadio
          legend={tr('settings.lineOrdering.legend')}
          name="line-ordering-mode"
          value={mode}
          disabled={!editable}
          options={LINE_ORDERING_MODES.map((value) => ({
            value,
            label: tr(`settings.lineOrdering.${value}`),
          }))}
          onChange={setMode}
        />
        <p className="g-t-s" style={s('margin:0')} aria-live="polite">
          {tr(`settings.lineOrdering.${mode}Hint`)}
        </p>
        {mode === 'scheduled' ? (
          <a className="g-t-s" href="#/settings/hours">
            {tr('settings.lineOrdering.hoursLink')}
          </a>
        ) : null}
      </FormCard>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
