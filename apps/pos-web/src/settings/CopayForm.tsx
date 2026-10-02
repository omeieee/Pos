import { formatDate } from '@sds/i18n';
import { isoDateSchema } from '@sds/shared';
import { useState } from 'react';
import { useLocale, useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import {
  buildCopayInput,
  type CopayField,
  type CopayForm as CopayValues,
  copayFormFrom,
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
  // A new scheme is created for the storefront (one channel); a saved one keeps its own.
  const channelCount = scheme ? scheme.channels.length : 1;
  const problems = tried ? validateCopayForm(form, { channels: channelCount }) : [];
  const set = (patch: Partial<CopayValues>) => setForm({ ...form, ...patch });
  const fieldError = (field: CopayField) =>
    problems.includes(field) ? tr(`settings.copay.error.${field}`) : undefined;
  const preview = (date: string) =>
    isoDateSchema.safeParse(date.trim()).success
      ? { hint: formatDate(`${date.trim()}T12:00:00+07:00`, locale, 'date') }
      : {};

  async function onSubmit() {
    setTried(true);
    if (validateCopayForm(form, { channels: channelCount }).length > 0) return;
    await submit(buildCopayInput(scheme, loaded.version, form));
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
      <p className="hint">{tr('settings.copay.rules')}</p>
      <p className="notice" role="note">
        <span>{tr('settings.copay.risk')}</span>
      </p>
      {scheme ? (
        <>
          <p className="muted">
            {tr('settings.copay.channels', {
              channels: scheme.channels.map((c) => tr(`orders.channel.${c}`)).join(' · '),
            })}
          </p>
          <p className="hint">{tr('settings.copay.channelsNote')}</p>
        </>
      ) : (
        <p className="muted">{tr('settings.copay.new')}</p>
      )}

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
      <div className="sset__pair">
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
      </div>
      <div className="sset__pair">
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
      </div>
      <div className="sset__pair">
        <TextField
          label={tr('settings.copay.fromTime')}
          value={form.fromTime}
          inputMode="numeric"
          maxLength={5}
          disabled={!editable}
          error={fieldError('fromTime')}
          onChange={(fromTime) => set({ fromTime })}
        />
        <TextField
          label={tr('settings.copay.toTime')}
          value={form.toTime}
          inputMode="numeric"
          maxLength={5}
          disabled={!editable}
          error={fieldError('toTime')}
          onChange={(toTime) => set({ toTime })}
        />
      </div>

      <div className="stack-sm">
        <label className={`pick${form.enabled ? ' pick--on' : ''}`}>
          <input
            className="visually-hidden"
            type="checkbox"
            checked={form.enabled}
            disabled={!editable}
            onChange={(event) => set({ enabled: event.target.checked })}
          />
          {tr('settings.copay.enabled')}
        </label>
        <p className="hint">{tr('settings.copay.enabledHint')}</p>
        {fieldError('enabled') ? (
          <p className="error" role="alert">
            {fieldError('enabled')}
          </p>
        ) : null}
      </div>
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
