import type { PaymentsSettings } from '@sds/shared';
import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { buildPaymentsPatch } from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

const METHODS = ['cash', 'promptpay', 'platform', 'other'] as const;

/** Which payment methods staff may offer. The co-pay scheme has its own switch. */
export function PaymentsForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'payments'>) {
  const tr = useT();
  const [form, setForm] = useState<PaymentsSettings>(() => ({ ...loaded.value }));

  return (
    <form
      className="sset__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(buildPaymentsPatch(loaded.value, loaded.version, form));
      }}
    >
      <p className="hint">{tr('settings.payments.hint')}</p>
      <div className="picks">
        {METHODS.map((method) => (
          <label key={method} className={`pick${form[method] ? ' pick--on' : ''}`}>
            <input
              className="visually-hidden"
              type="checkbox"
              checked={form[method]}
              disabled={!editable}
              onChange={(event) => setForm({ ...form, [method]: event.target.checked })}
            />
            {tr(`settings.payments.${method}`)}
          </label>
        ))}
      </div>
      <p className="hint">{tr('settings.payments.govNote')}</p>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
