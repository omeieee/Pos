import { formatBaht } from '@sds/i18n';
import { useState } from 'react';
import { errorText } from '../../api/errors.ts';
import { useAuthStore, useLocale, useServices, useT } from '../../ui/hooks.ts';
import { TextField } from '../../ui/TextField.tsx';
import {
  buildOpeningBody,
  type OpeningForm,
  openingFormFrom,
  validateOpeningForm,
} from './cash-model.ts';
import { useDayText } from './FinanceParts.tsx';
import { useCashOpening } from './use-finance.ts';

/**
 * The owner's start amount (stored as the setting `cash_opening`): the figure at the start of a
 * business day from which the report keeps its running net (receipts minus payments). The shop has no
 * cash drawer, so it is just a starting point the owner chooses. Saving (and clearing) is sensitive: the auth store asks for the
 * step-up first, and the server audits it. The version comes from the setting's own read.
 */
export function OpeningCash({
  today,
  onSaved,
}: {
  today: string;
  /** Called after a save so the report is read again. */
  onSaved: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const dayText = useDayText();
  const auth = useAuthStore();
  const { api } = useServices();
  const setting = useCashOpening();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OpeningForm>({ amount: '', asOf: today });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const current = setting.data?.value ?? null;
  const problems = tried ? validateOpeningForm(form) : [];

  async function run(call: () => ReturnType<typeof api.settings.cashOpening.save>) {
    setSaving(true);
    setMessage(null);
    const result = await auth.runSensitive(call);
    setSaving(false);
    if (result.ok) {
      setMessage({ ok: true, text: tr('cash.opening.saved') });
      setEditing(false);
      setTried(false);
      setting.reload();
      onSaved();
    } else if (result.error === null) {
      setMessage({ ok: false, text: tr('error.ownerSignInNeeded') });
    } else {
      setMessage({ ok: false, text: errorText(tr, result.error) });
    }
  }

  function save() {
    setTried(true);
    const body = buildOpeningBody(form, setting.data?.version ?? 0);
    if (!body || saving) return;
    void run(() => api.settings.cashOpening.save(body));
  }

  function clear() {
    if (saving) return;
    void run(() =>
      api.settings.cashOpening.save({
        expectedVersion: setting.data?.version ?? 0,
        amountSatang: null,
        asOf: null,
      }),
    );
  }

  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('cash.opening.title')}</div>
      {setting.load === 'error' ? (
        <p role="alert" className="g-t-s fin-note">
          {tr('fin.error')}
        </p>
      ) : current?.amountSatang != null && current.asOf !== null ? (
        <p className="g-t-s fin-note">
          {tr('cash.opening.value', {
            amount: formatBaht(current.amountSatang, locale),
            date: dayText(current.asOf),
          })}
        </p>
      ) : setting.load === 'ok' ? (
        <p className="g-t-s fin-note">{tr('cash.opening.notSet')}</p>
      ) : null}
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className="g-t-s fin-note">
          {message.text}
        </p>
      ) : null}
      {editing ? (
        <div className="fin-stack">
          <TextField
            label={tr('cash.opening.amount')}
            inputMode="decimal"
            value={form.amount}
            error={problems.includes('amount') ? tr('cash.opening.invalid') : undefined}
            onChange={(amount) => setForm({ ...form, amount })}
          />
          <TextField
            type="date"
            label={tr('cash.opening.asOf')}
            value={form.asOf}
            error={problems.includes('asOf') ? tr('cash.opening.invalid') : undefined}
            onChange={(asOf) => setForm({ ...form, asOf })}
          />
          <p className="g-t-c fin-note">{tr('tax.allow.stepUp')}</p>
          <div className="fin-actions">
            <button type="button" className="g-btn g-btn-p" disabled={saving} onClick={save}>
              {tr('cash.opening.save')}
            </button>
            <button
              type="button"
              className="g-btn"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              {tr('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="fin-actions">
          <button
            type="button"
            className="g-btn"
            disabled={setting.load !== 'ok'}
            onClick={() => {
              setForm(openingFormFrom(current ?? { amountSatang: null, asOf: null }, today));
              setEditing(true);
            }}
          >
            {tr('cash.opening.edit')}
          </button>
          {current?.amountSatang != null ? (
            <button type="button" className="g-btn" disabled={saving} onClick={clear}>
              {tr('cash.opening.clear')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
