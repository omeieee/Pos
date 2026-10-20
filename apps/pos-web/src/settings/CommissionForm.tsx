import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { TextField } from '../ui/TextField.tsx';
import {
  buildCommissionPatch,
  type CommissionField,
  commissionFormFrom,
  validateCommissionForm,
} from './commission-model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/**
 * What Grab and LINE MAN keep of a sale, as a percent. There is no built-in rate: a blank field is
 * "rate not set" and the reports say their figures are not complete. Owner only; the save asks for
 * the owner's step-up first (the store does it) and is audited by the server.
 */
export function CommissionForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'platformCommission'>) {
  const tr = useT();
  const [form, setForm] = useState(() => commissionFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const problems = tried ? validateCommissionForm(form) : [];
  const fieldProps = (field: CommissionField) => ({
    value: form[field],
    inputMode: 'decimal' as const,
    maxLength: 6,
    disabled: !editable,
    error: problems.includes(field) ? tr('settings.commission.error.rate') : undefined,
    onChange: (value: string) => setForm({ ...form, [field]: value }),
  });
  const savedRate = { grab: loaded.value.grabRateBp, lineman: loaded.value.linemanRateBp };

  async function onSubmit() {
    setTried(true);
    if (validateCommissionForm(form).length > 0) return;
    await submit(buildCommissionPatch(loaded.value, loaded.version, form));
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
        <TextField
          icon="store"
          label={tr('settings.commission.grab')}
          {...fieldProps('grab')}
          {...(savedRate.grab === null ? { hint: tr('settings.commission.notSet') } : {})}
        />
        <TextField
          icon="store"
          label={tr('settings.commission.lineman')}
          {...fieldProps('lineman')}
          {...(savedRate.lineman === null ? { hint: tr('settings.commission.notSet') } : {})}
        />
        <p className="g-t-c" style={s('margin:0')}>
          {tr('settings.commission.hint')}
        </p>
      </FormCard>
      {editable ? (
        <Callout tone="info" icon="lock" role="note">
          {tr('settings.commission.ownerOnly')}
        </Callout>
      ) : null}
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
