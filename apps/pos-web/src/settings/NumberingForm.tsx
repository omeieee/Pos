import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { buildNumberingPatch, numberingFormFrom, validateNumberingForm } from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/** The time the business day ends (and order numbers start again). The time zone is only shown. */
export function NumberingForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'numbering'>) {
  const tr = useT();
  const [form, setForm] = useState(() => numberingFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const invalid = tried && validateNumberingForm(form).length > 0;

  async function onSubmit() {
    setTried(true);
    if (validateNumberingForm(form).length > 0) return;
    await submit(buildNumberingPatch(loaded.value, loaded.version, form));
  }

  return (
    <form
      className="sset__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <TextField
        label={tr('settings.numbering.cutoff')}
        value={form.cutoff}
        inputMode="numeric"
        maxLength={5}
        hint={tr('settings.numbering.hint')}
        disabled={!editable}
        error={invalid ? tr('settings.numbering.error') : undefined}
        onChange={(cutoff) => setForm({ cutoff })}
      />
      <p className="muted">{tr('settings.numbering.zone', { zone: loaded.value.timeZone })}</p>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
