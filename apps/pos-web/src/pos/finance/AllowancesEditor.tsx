import { formatBaht } from '@sds/i18n';
import type { TaxProfileResponse } from '@sds/shared';
import { useState } from 'react';
import { errorText } from '../../api/errors.ts';
import { Gi } from '../../design/icons.tsx';
import { useAuthStore, useLocale, useServices, useT } from '../../ui/hooks.ts';
import { TextField } from '../../ui/TextField.tsx';
import {
  buildTaxProfile,
  formFromProfile,
  type MethodChoice,
  type TaxProfileForm,
  validateTaxProfileForm,
} from './tax-model.ts';
import type { Load } from './use-finance.ts';

const METHODS: readonly MethodChoice[] = ['auto', 'actual', 'flat'];

function Form({
  year,
  profile,
  personalSatang,
  onSaved,
}: {
  year: number;
  profile: TaxProfileResponse;
  personalSatang: number | null;
  onSaved: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const auth = useAuthStore();
  const { api } = useServices();
  const [form, setForm] = useState<TaxProfileForm>(() => formFromProfile(profile));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const problems = tried ? validateTaxProfileForm(form) : [];
  const problemOf = (index: number, field: 'label' | 'amount') =>
    problems.some((p) => p.index === index && p.field === field);

  async function save() {
    setTried(true);
    if (validateTaxProfileForm(form).length > 0 || saving) return;
    setSaving(true);
    setMessage(null);
    // Saving the owner's tax inputs is sensitive: the auth store asks for the step-up first.
    const result = await auth.runSensitive(() =>
      api.settings.taxProfile.save(year, buildTaxProfile(form)),
    );
    setSaving(false);
    if (result.ok) {
      setMessage({ ok: true, text: tr('tax.allow.saved') });
      onSaved();
    } else if (result.error === null) {
      setMessage({ ok: false, text: tr('error.ownerSignInNeeded') });
    } else {
      setMessage({ ok: false, text: errorText(tr, result.error) });
    }
  }

  const setRow = (index: number, change: Partial<TaxProfileForm['items'][number]>) =>
    setForm({
      ...form,
      items: form.items.map((row, i) => (i === index ? { ...row, ...change } : row)),
    });

  return (
    <>
      {personalSatang !== null ? (
        <dl className="fin-lines">
          <div className="fin-line">
            <dt>{tr('tax.allow.personal')}</dt>
            <dd>{formatBaht(personalSatang, locale)}</dd>
          </div>
        </dl>
      ) : null}
      <div className="g-t-3">{tr('tax.allow.extra')}</div>
      {form.items.length === 0 ? <p className="g-t-s fin-note">{tr('tax.allow.none')}</p> : null}
      <ul className="fin-allow">
        {form.items.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; they only move at the end
          <li key={index} className="fin-allow__row">
            <TextField
              label={tr('tax.allow.label')}
              value={row.label}
              maxLength={80}
              error={problemOf(index, 'label') ? tr('tax.allow.error.label') : undefined}
              onChange={(label) => setRow(index, { label })}
            />
            <TextField
              label={tr('tax.allow.amount')}
              inputMode="decimal"
              value={row.amount}
              error={problemOf(index, 'amount') ? tr('tax.allow.error.amount') : undefined}
              onChange={(amount) => setRow(index, { amount })}
            />
            <button
              type="button"
              className="g-btn g-btn-icon fin-allow__remove"
              aria-label={tr('tax.allow.remove', { label: row.label })}
              onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== index) })}
            >
              <Gi n="x" size="sm" />
            </button>
          </li>
        ))}
      </ul>
      <div className="fin-actions">
        <button
          type="button"
          className="g-btn"
          onClick={() => setForm({ ...form, items: [...form.items, { label: '', amount: '' }] })}
        >
          <Gi n="plus" size="sm" />
          {tr('tax.allow.add')}
        </button>
      </div>
      <fieldset className="g-seg fin-seg" aria-label={tr('tax.allow.method')}>
        {METHODS.map((value) => (
          <label key={value} className={`g-chip${form.method === value ? ' g-on' : ''}`}>
            <input
              type="radio"
              name="tax-method"
              checked={form.method === value}
              onChange={() => setForm({ ...form, method: value })}
            />
            {value === 'auto' ? tr('tax.allow.method.auto') : tr(`tax.method.${value}`)}
          </label>
        ))}
      </fieldset>
      <p className="g-t-c fin-note">{tr('tax.note.allowancesUnchecked')}</p>
      <p className="g-t-c fin-note">{tr('tax.allow.stepUp')}</p>
      <div className="fin-actions">
        <button
          type="button"
          className="g-btn g-btn-p"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? tr('exp.saving') : tr('tax.allow.save')}
        </button>
      </div>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className="g-t-s fin-note">
          {message.text}
        </p>
      ) : null}
    </>
  );
}

/**
 * The owner's own tax inputs for the year: extra allowances (the personal one comes with the
 * rules) and which expense method to prefer. The save replaces the whole profile of the year, asks
 * for the owner's step-up first, and then the estimate is read again. The amounts are typed in
 * baht and sent as satang; the server does not check caps, and says so (a note on the estimate).
 */
export function AllowancesEditor({
  year,
  personalSatang,
  profile,
  onSaved,
}: {
  year: number;
  /** The personal allowance the last estimate used (the rules file's, halved on the half-year return). */
  personalSatang: number | null;
  profile: { load: Load; data: TaxProfileResponse | null; reload: () => void };
  onSaved: () => void;
}) {
  const tr = useT();
  const ready = profile.load === 'ok' && profile.data !== null;
  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('tax.allow.title')}</div>
      <fieldset aria-label={tr('tax.allow.title')} className="fin-stack fin-fieldset">
        {profile.load === 'error' ? (
          <div role="alert" className="g-sunk fin-error">
            <span>{tr('tax.allow.loadFailed')}</span>
            <button type="button" className="g-btn" onClick={profile.reload}>
              {tr('common.retry')}
            </button>
          </div>
        ) : null}
        {profile.load === 'loading' && !profile.data ? (
          <p role="status" className="g-t-s fin-quiet">
            {tr('common.loading')}
          </p>
        ) : null}
        {ready && profile.data ? (
          <Form
            key={year}
            year={year}
            profile={profile.data}
            personalSatang={personalSatang}
            onSaved={() => {
              onSaved();
              profile.reload();
            }}
          />
        ) : (
          <div className="fin-actions">
            <button type="button" className="g-btn g-btn-p" disabled>
              {tr('tax.allow.save')}
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );
}
