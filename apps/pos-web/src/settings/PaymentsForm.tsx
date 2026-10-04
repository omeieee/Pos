import type { PaymentsSettings } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard, SwitchRow } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
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
      style={s('display:flex;flex-direction:column;gap:18px')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(buildPaymentsPatch(loaded.value, loaded.version, form));
      }}
    >
      <FormCard gap={4}>
        <p className="g-t-s" style={s('margin:0 0 8px')}>
          {tr('settings.payments.hint')}
        </p>
        {METHODS.map((method, index) => (
          <div key={method}>
            {index > 0 ? <hr className="g-hair" /> : null}
            <SwitchRow
              label={tr(`settings.payments.${method}`)}
              checked={form[method]}
              disabled={!editable}
              onChange={(checked) => setForm({ ...form, [method]: checked })}
            />
          </div>
        ))}
      </FormCard>
      <Callout tone="info" role="note">
        {tr('settings.payments.govNote')}
      </Callout>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
