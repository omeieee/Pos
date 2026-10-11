import { THAI_BANK_CODES } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { SelectField, TextField } from '../ui/TextField.tsx';
import {
  type BankAccountField,
  bankAccountFormFrom,
  buildBankAccountPatch,
  validateBankAccountForm,
} from './bank-account-model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';
import './settings-glass.css';

/**
 * The bank account customers transfer to, used only to compare the receiver on a slip (D-26). Owner
 * only: the save asks for the owner's step-up first (the store does it). The screen only ever holds
 * the masked account; the full number is typed here and sent, never shown back.
 */
export function BankAccountForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'bankAccount'>) {
  const tr = useT();
  const saved = loaded.value;
  const [form, setForm] = useState(() => bankAccountFormFrom(saved));
  const [tried, setTried] = useState(false);
  const problems: BankAccountField[] = tried ? validateBankAccountForm(form) : [];

  async function onSubmit() {
    setTried(true);
    if (validateBankAccountForm(form).length > 0) return;
    await submit(buildBankAccountPatch(saved, loaded.version, form));
  }

  const bankName = (code: (typeof THAI_BANK_CODES)[number]) =>
    tr(`settings.bankAccount.bankName.${code}`);
  const shown = saved.accountMasked
    ? saved.bankCode
      ? tr('settings.bankAccount.shownBank', {
          bank: bankName(saved.bankCode),
          masked: saved.accountMasked,
        })
      : tr('settings.bankAccount.shown', { masked: saved.accountMasked })
    : saved.configured
      ? tr('settings.bankAccount.configuredOnly')
      : tr('settings.bankAccount.none');

  return (
    <form
      style={s('display:flex;flex-direction:column;gap:18px')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <FormCard gap={12}>
        <div style={s('display:flex;align-items:center;gap:14px')}>
          <div
            className="g-ico"
            style={s('background:#2457b8;width:44px;height:44px;border-radius:14px')}
          >
            <Gi n="bank" />
          </div>
          <p className="gset-account">{shown}</p>
        </div>
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.bankAccount.privacy')}
        </p>
      </FormCard>
      {editable ? (
        <FormCard>
          <SelectField
            label={tr('settings.bankAccount.bank')}
            value={form.bankCode}
            onChange={(bankCode) => setForm({ ...form, bankCode })}
          >
            <option value="">{tr('settings.bankAccount.bankNone')}</option>
            {THAI_BANK_CODES.map((code) => (
              <option key={code} value={code}>
                {bankName(code)}
              </option>
            ))}
          </SelectField>
          <TextField
            icon="bank"
            label={tr('settings.bankAccount.number')}
            value={form.accountNumber}
            inputMode="numeric"
            maxLength={24}
            hint={tr('settings.bankAccount.numberHint')}
            error={
              problems.includes('accountNumber')
                ? tr('settings.bankAccount.error.accountNumber')
                : undefined
            }
            onChange={(accountNumber) => setForm({ ...form, accountNumber })}
          />
        </FormCard>
      ) : null}
      {editable ? (
        <Callout tone="info" icon="lock" role="note">
          {tr('settings.bankAccount.ownerOnly')}
        </Callout>
      ) : null}
      <SaveBar editable={editable} busy={busy} saving={saving} />
      {editable && saved.configured ? (
        <div className="gsave">
          <button
            type="button"
            className="g-btn"
            disabled={busy || saving}
            onClick={() =>
              void submit({ expectedVersion: loaded.version, bankCode: null, accountNumber: null })
            }
          >
            {tr('settings.bankAccount.clear')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
