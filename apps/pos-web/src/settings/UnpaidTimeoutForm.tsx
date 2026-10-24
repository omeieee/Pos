import { UNPAID_TIMEOUT_MAX_MINUTES, UNPAID_TIMEOUT_MIN_MINUTES } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard, SwitchRow } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import {
  buildUnpaidTimeoutPatch,
  unpaidTimeoutFormFrom,
  validateUnpaidTimeoutForm,
} from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/**
 * Whether a LINE order that is not paid in time is cancelled by itself (D-41), and after how many
 * minutes, with plain words about what happens (and what does not: no message to the customer).
 */
export function UnpaidTimeoutForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'unpaidTimeout'>) {
  const tr = useT();
  const [form, setForm] = useState(() => unpaidTimeoutFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const range = { min: UNPAID_TIMEOUT_MIN_MINUTES, max: UNPAID_TIMEOUT_MAX_MINUTES };
  const invalid = tried && validateUnpaidTimeoutForm(form).length > 0;

  async function onSubmit() {
    setTried(true);
    if (validateUnpaidTimeoutForm(form).length > 0) return;
    await submit(buildUnpaidTimeoutPatch(loaded.value, loaded.version, form));
  }

  return (
    <form
      style={s('display:flex;flex-direction:column;gap:18px')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <FormCard>
        <SwitchRow
          label={tr('settings.unpaidTimeout.switch')}
          hint={tr('settings.unpaidTimeout.switchHint')}
          checked={form.enabled}
          disabled={!editable}
          onChange={(enabled) => setForm({ ...form, enabled })}
        />
        <TextField
          icon="clock"
          label={tr('settings.unpaidTimeout.minutes')}
          value={form.minutes}
          inputMode="numeric"
          maxLength={3}
          hint={tr('settings.unpaidTimeout.minutesHint', range)}
          disabled={!editable}
          error={invalid ? tr('settings.unpaidTimeout.error', range) : undefined}
          onChange={(minutes) => setForm({ ...form, minutes })}
        />
        <p className="g-t-s" style={s('margin:0;font-weight:500')} aria-live="polite">
          {loaded.value.enabled
            ? tr('settings.unpaidTimeout.stateOn', { minutes: loaded.value.minutes })
            : tr('settings.unpaidTimeout.stateOff')}
        </p>
        <ul
          className="g-t-s"
          style={s('margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px')}
        >
          <li>{tr('settings.unpaidTimeout.explainAuto')}</li>
          <li>{tr('settings.unpaidTimeout.explainClaimed')}</li>
          <li>{tr('settings.unpaidTimeout.explainLate')}</li>
        </ul>
      </FormCard>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
