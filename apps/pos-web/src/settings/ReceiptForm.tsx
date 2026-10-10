import { useState } from 'react';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { TextField } from '../ui/TextField.tsx';
import {
  buildReceiptPatch,
  type ReceiptField,
  receiptFormFrom,
  validateReceiptForm,
} from './receipt-model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/**
 * The tax ID and address printed on receipts. Owner only: the save asks for the owner's step-up
 * first (the store does it). Both may stay empty; the receipt then skips those lines.
 */
export function ReceiptForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'receipt'>) {
  const tr = useT();
  const [form, setForm] = useState(() => receiptFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const problems = tried ? validateReceiptForm(form) : [];
  const fieldError = (field: ReceiptField) =>
    problems.includes(field) ? tr(`settings.receipt.error.${field}`) : undefined;

  async function onSubmit() {
    setTried(true);
    if (validateReceiptForm(form).length > 0) return;
    await submit(buildReceiptPatch(loaded.value, loaded.version, form));
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
          icon="receipt"
          label={tr('settings.receipt.taxId')}
          value={form.taxId}
          inputMode="numeric"
          maxLength={17}
          disabled={!editable}
          error={fieldError('taxId')}
          onChange={(taxId) => setForm({ ...form, taxId })}
        />
        <TextField
          icon="building"
          label={tr('settings.receipt.address')}
          value={form.address}
          maxLength={200}
          disabled={!editable}
          error={fieldError('address')}
          onChange={(address) => setForm({ ...form, address })}
        />
        <p className="g-t-c" style={s('margin:0')}>
          {tr('settings.receipt.hint')}
        </p>
      </FormCard>
      {editable ? (
        <Callout tone="info" icon="lock" role="note">
          {tr('settings.receipt.ownerOnly')}
        </Callout>
      ) : null}
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
