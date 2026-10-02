import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { buildShopPatch, shopFormFrom, validateShopForm } from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/** Shop name, phone and address. Only what changed is sent. */
export function ShopForm({ loaded, editable, saving, busy, submit }: SectionBodyProps<'shop'>) {
  const tr = useT();
  const [form, setForm] = useState(() => shopFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const problems = tried ? validateShopForm(form) : [];
  const fieldError = (field: 'nameTh' | 'nameEn' | 'phone' | 'address') =>
    problems.includes(field) ? tr(`settings.shop.error.${field}`) : undefined;

  async function onSubmit() {
    setTried(true);
    if (validateShopForm(form).length > 0) return;
    await submit(buildShopPatch(loaded.value, loaded.version, form));
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
        label={tr('settings.shop.nameTh')}
        value={form.nameTh}
        maxLength={80}
        disabled={!editable}
        error={fieldError('nameTh')}
        onChange={(nameTh) => setForm({ ...form, nameTh })}
      />
      <TextField
        label={tr('settings.shop.nameEn')}
        value={form.nameEn}
        maxLength={80}
        hint={tr('settings.optional')}
        disabled={!editable}
        error={fieldError('nameEn')}
        onChange={(nameEn) => setForm({ ...form, nameEn })}
      />
      <TextField
        label={tr('settings.shop.phone')}
        value={form.phone}
        type="tel"
        inputMode="numeric"
        maxLength={30}
        hint={tr('settings.optional')}
        disabled={!editable}
        error={fieldError('phone')}
        onChange={(phone) => setForm({ ...form, phone })}
      />
      <TextField
        label={tr('settings.shop.address')}
        value={form.address}
        maxLength={200}
        hint={tr('settings.optional')}
        disabled={!editable}
        error={fieldError('address')}
        onChange={(address) => setForm({ ...form, address })}
      />
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
