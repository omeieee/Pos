import { formatDate } from '@sds/i18n';
import { isoDateSchema, WEEKDAYS } from '@sds/shared';
import { useState } from 'react';
import { useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { TextField } from '../ui/TextField.tsx';
import {
  buildHoursPatch,
  type HoursForm as HoursFormValues,
  hasOtherHoursRules,
  hoursFormFrom,
  validateHoursForm,
  type WindowForm,
} from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

function WindowFields({
  legend,
  value,
  disabled,
  error,
  onChange,
}: {
  legend: string;
  value: WindowForm;
  disabled: boolean;
  error: boolean;
  onChange: (next: WindowForm) => void;
}) {
  const tr = useT();
  return (
    <fieldset className="group sset__window">
      <legend className="label">{legend}</legend>
      <div className="sset__pair">
        <TextField
          label={tr('settings.hours.open')}
          value={value.open}
          inputMode="numeric"
          maxLength={5}
          disabled={disabled}
          onChange={(open) => onChange({ ...value, open })}
        />
        <TextField
          label={tr('settings.hours.close')}
          value={value.close}
          inputMode="numeric"
          maxLength={5}
          disabled={disabled}
          onChange={(close) => onChange({ ...value, close })}
        />
      </div>
      {error ? (
        <p className="error" role="alert">
          {tr('settings.hours.windowError')}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Opening hours: the two daily windows, the weekdays that are always closed, and the dates closed
 * all day. Rules this form does not show (a weekday with its own window, a date with its own
 * hours) are kept as they are.
 */
export function HoursForm({ loaded, editable, saving, busy, submit }: SectionBodyProps<'hours'>) {
  const tr = useT();
  const locale = useLocale();
  const [form, setForm] = useState<HoursFormValues>(() => hoursFormFrom(loaded.value));
  const [tried, setTried] = useState(false);
  const problems = tried ? validateHoursForm(loaded.value, form) : [];

  async function onSubmit() {
    setTried(true);
    if (validateHoursForm(loaded.value, form).length > 0) return;
    await submit(buildHoursPatch(loaded.value, loaded.version, form));
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
      <WindowFields
        legend={tr('settings.hours.storefront')}
        value={form.storefront}
        disabled={!editable}
        error={problems.includes('storefront')}
        onChange={(storefront) => setForm({ ...form, storefront })}
      />
      <WindowFields
        legend={tr('settings.hours.delivery')}
        value={form.delivery}
        disabled={!editable}
        error={problems.includes('delivery')}
        onChange={(delivery) => setForm({ ...form, delivery })}
      />

      <fieldset className="group">
        <legend className="label">{tr('settings.hours.closedDays')}</legend>
        <p className="hint">{tr('settings.hours.closedDaysHint')}</p>
        <div className="picks">
          {WEEKDAYS.map((day) => (
            <label key={day} className={`pick${form.closedDays[day] ? ' pick--on' : ''}`}>
              <input
                className="visually-hidden"
                type="checkbox"
                checked={form.closedDays[day]}
                disabled={!editable}
                onChange={(event) =>
                  setForm({
                    ...form,
                    closedDays: { ...form.closedDays, [day]: event.target.checked },
                  })
                }
              />
              {tr(`settings.weekday.${day}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="group">
        <legend className="label">{tr('settings.hours.closures')}</legend>
        {form.closures.length === 0 ? (
          <p className="muted">{tr('settings.hours.closuresEmpty')}</p>
        ) : (
          <ul className="sset__list">
            {form.closures.map((closure, index) => {
              const valid = isoDateSchema.safeParse(closure.date.trim()).success;
              return (
                // The rows have no id of their own: their place in the list is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={index} className="sset__row">
                  <div className="sset__row-fields">
                    <TextField
                      label={tr('settings.hours.closureDate')}
                      type="date"
                      value={closure.date}
                      disabled={!editable}
                      {...(valid
                        ? {
                            hint: formatDate(
                              `${closure.date.trim()}T12:00:00+07:00`,
                              locale,
                              'date',
                            ),
                          }
                        : {})}
                      error={
                        problems.includes(`closure:${index}`)
                          ? tr('settings.hours.closureError')
                          : undefined
                      }
                      onChange={(date) =>
                        setForm({
                          ...form,
                          closures: form.closures.map((c, i) => (i === index ? { ...c, date } : c)),
                        })
                      }
                    />
                    <TextField
                      label={tr('settings.hours.closureNote')}
                      value={closure.note}
                      maxLength={100}
                      disabled={!editable}
                      onChange={(note) =>
                        setForm({
                          ...form,
                          closures: form.closures.map((c, i) => (i === index ? { ...c, note } : c)),
                        })
                      }
                    />
                  </div>
                  {editable ? (
                    <button
                      type="button"
                      className="btn btn-soft"
                      aria-label={tr('settings.hours.closureRemove', { date: closure.date })}
                      onClick={() =>
                        setForm({ ...form, closures: form.closures.filter((_, i) => i !== index) })
                      }
                    >
                      <Icon name="x" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {problems.includes('closures') ? (
          <p className="error" role="alert">
            {tr('settings.hours.tooMany')}
          </p>
        ) : null}
        {editable ? (
          <button
            type="button"
            className="btn btn-soft sset__add"
            onClick={() =>
              setForm({ ...form, closures: [...form.closures, { date: '', note: '' }] })
            }
          >
            <Icon name="plus" />
            {tr('settings.hours.closureAdd')}
          </button>
        ) : null}
      </fieldset>

      {hasOtherHoursRules(loaded.value) ? (
        <p className="hint">{tr('settings.hours.keptNote')}</p>
      ) : null}
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
