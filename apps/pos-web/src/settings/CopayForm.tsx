import { formatDate } from '@sds/i18n';
import { isoDateSchema } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { FieldPair, FormCard, SwitchRow } from '../ui/FormParts.tsx';
import { useLocale, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { FieldMessage, TextField } from '../ui/TextField.tsx';
import {
  buildCopayInput,
  type CopayField,
  type CopayForm as CopayValues,
  copayFormFrom,
  isStorefrontOnly,
  validateCopayForm,
} from './copay-model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

/**
 * The ไทยช่วยไทย scheme: names, the government's share, the caps, the dates and the daily hours,
 * and the switch that turns it on. Nothing about the scheme is preset: the owner types it. The
 * rules that keep it face to face are stated on the page and enforced by the server and the shared
 * availability check, not by this form; the channels are shown and never edited here.
 */
export function CopayForm({ loaded, editable, saving, busy, submit }: SectionBodyProps<'copay'>) {
  const tr = useT();
  const locale = useLocale();
  const scheme = loaded.value;
  const [form, setForm] = useState<CopayValues>(() => copayFormFrom(scheme));
  const [tried, setTried] = useState(false);
  // A new scheme is created for the storefront; a saved one keeps its own channels.
  const channels = scheme ? scheme.channels : ['storefront'];
  const rule = { channels, wasEnabled: scheme?.enabled ?? false };
  const storefrontOnly = isStorefrontOnly(channels);
  const problems = tried ? validateCopayForm(form, rule) : [];
  const set = (patch: Partial<CopayValues>) => setForm({ ...form, ...patch });
  const fieldError = (field: CopayField) =>
    problems.includes(field) ? tr(`settings.copay.error.${field}`) : undefined;
  const preview = (date: string) =>
    isoDateSchema.safeParse(date.trim()).success
      ? { hint: formatDate(`${date.trim()}T12:00:00+07:00`, locale, 'date') }
      : {};

  async function onSubmit() {
    setTried(true);
    if (validateCopayForm(form, rule).length > 0) return;
    await submit(buildCopayInput(scheme, loaded.version, form));
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
      <p className="g-t-s" style={s('margin:0')}>
        {tr('settings.copay.rules')}
      </p>
      <Callout tone="warn" role="note">
        {tr('settings.copay.risk')}
      </Callout>
      {scheme ? (
        <FormCard gap={10}>
          <p className="g-t-3" style={s('margin:0')}>
            {tr('settings.copay.channels', {
              channels: scheme.channels.map((c) => tr(`orders.channel.${c}`)).join(' · '),
            })}
          </p>
          <p className="g-t-c" style={s('margin:0')}>
            {tr('settings.copay.channelsNote')}
          </p>
          {storefrontOnly ? null : (
            <Callout tone="bad" role="alert">
              {tr('settings.copay.channelsWarn')}
            </Callout>
          )}
        </FormCard>
      ) : (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.copay.new')}
        </p>
      )}

      <FormCard>
        <TextField
          label={tr('settings.copay.nameTh')}
          value={form.nameTh}
          maxLength={80}
          disabled={!editable}
          error={fieldError('nameTh')}
          onChange={(nameTh) => set({ nameTh })}
        />
        <TextField
          label={tr('settings.copay.nameEn')}
          value={form.nameEn}
          maxLength={80}
          hint={tr('settings.optional')}
          disabled={!editable}
          onChange={(nameEn) => set({ nameEn })}
        />
        <TextField
          label={tr('settings.copay.share')}
          value={form.share}
          inputMode="decimal"
          maxLength={6}
          hint={tr('settings.copay.shareHint')}
          disabled={!editable}
          error={fieldError('share')}
          onChange={(share) => set({ share })}
        />
        <FieldPair>
          <TextField
            label={tr('settings.copay.dailyCap')}
            value={form.dailyCap}
            inputMode="decimal"
            hint={tr('settings.copay.capHint')}
            disabled={!editable}
            error={fieldError('dailyCap')}
            onChange={(dailyCap) => set({ dailyCap })}
          />
          <TextField
            label={tr('settings.copay.totalCap')}
            value={form.totalCap}
            inputMode="decimal"
            hint={tr('settings.copay.capHint')}
            disabled={!editable}
            error={fieldError('totalCap')}
            onChange={(totalCap) => set({ totalCap })}
          />
        </FieldPair>
        <FieldPair>
          <TextField
            label={tr('settings.copay.from')}
            type="date"
            value={form.activeFrom}
            disabled={!editable}
            error={fieldError('activeFrom')}
            {...preview(form.activeFrom)}
            onChange={(activeFrom) => set({ activeFrom })}
          />
          <TextField
            label={tr('settings.copay.to')}
            type="date"
            value={form.activeTo}
            disabled={!editable}
            error={fieldError('activeTo')}
            {...preview(form.activeTo)}
            onChange={(activeTo) => set({ activeTo })}
          />
        </FieldPair>
        <FieldPair>
          <TextField
            icon="clock"
            label={tr('settings.copay.fromTime')}
            value={form.fromTime}
            inputMode="numeric"
            maxLength={5}
            disabled={!editable}
            error={fieldError('fromTime')}
            onChange={(fromTime) => set({ fromTime })}
          />
          <TextField
            icon="clock"
            label={tr('settings.copay.toTime')}
            value={form.toTime}
            inputMode="numeric"
            maxLength={5}
            disabled={!editable}
            error={fieldError('toTime')}
            onChange={(toTime) => set({ toTime })}
          />
        </FieldPair>
      </FormCard>

      <FormCard gap={8}>
        <SwitchRow
          label={tr('settings.copay.enabled')}
          hint={tr('settings.copay.enabledHint')}
          checked={form.enabled}
          disabled={!editable || (!storefrontOnly && !form.enabled)}
          onChange={(enabled) => set({ enabled })}
        />
        {fieldError('enabled') ? (
          <FieldMessage tone="bad">{fieldError('enabled')}</FieldMessage>
        ) : null}
      </FormCard>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
