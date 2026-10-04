import { formatDate } from '@sds/i18n';
import { isoDateSchema, WEEKDAYS } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { CheckChip, FieldGroup, FieldPair, FormCard } from '../ui/FormParts.tsx';
import { useLocale, useT } from '../ui/hooks.ts';
import { FieldMessage, TextField } from '../ui/TextField.tsx';
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
import './settings-glass.css';

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
    <fieldset className="gset gset--title" style={s('gap:10px')}>
      <legend>{legend}</legend>
      <FieldPair>
        <TextField
          icon="clock"
          label={tr('settings.hours.open')}
          value={value.open}
          inputMode="numeric"
          maxLength={5}
          disabled={disabled}
          onChange={(open) => onChange({ ...value, open })}
        />
        <TextField
          icon="clock"
          label={tr('settings.hours.close')}
          value={value.close}
          inputMode="numeric"
          maxLength={5}
          disabled={disabled}
          onChange={(close) => onChange({ ...value, close })}
        />
      </FieldPair>
      {error ? <FieldMessage tone="bad">{tr('settings.hours.windowError')}</FieldMessage> : null}
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
      style={s('display:flex;flex-direction:column;gap:18px')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <FormCard gap={22}>
        <WindowFields
          legend={tr('settings.hours.storefront')}
          value={form.storefront}
          disabled={!editable}
          error={problems.includes('storefront')}
          onChange={(storefront) => setForm({ ...form, storefront })}
        />
        <hr className="g-hair" />
        <WindowFields
          legend={tr('settings.hours.delivery')}
          value={form.delivery}
          disabled={!editable}
          error={problems.includes('delivery')}
          onChange={(delivery) => setForm({ ...form, delivery })}
        />
      </FormCard>

      <FormCard>
        <FieldGroup
          title
          legend={tr('settings.hours.closedDays')}
          hint={tr('settings.hours.closedDaysHint')}
        >
          <div className="gchips">
            {WEEKDAYS.map((day) => (
              <CheckChip
                key={day}
                label={tr(`settings.weekday.${day}`)}
                checked={form.closedDays[day]}
                disabled={!editable}
                onChange={(checked) =>
                  setForm({ ...form, closedDays: { ...form.closedDays, [day]: checked } })
                }
              />
            ))}
          </div>
        </FieldGroup>
      </FormCard>

      <FormCard>
        <fieldset className="gset gset--title">
          <legend>{tr('settings.hours.closures')}</legend>
          {form.closures.length === 0 ? (
            <p className="g-t-s" style={s('margin:0')}>
              {tr('settings.hours.closuresEmpty')}
            </p>
          ) : (
            <ul className="gset-list" style={s('display:flex;flex-direction:column;gap:12px')}>
              {form.closures.map((closure, index) => {
                const valid = isoDateSchema.safeParse(closure.date.trim()).success;
                return (
                  // The rows have no id of their own: their place in the list is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <li key={index} className="g-sunk gset-closure">
                    <div style={s('flex:1 1 auto;min-width:0')}>
                      <FieldPair>
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
                              closures: form.closures.map((c, i) =>
                                i === index ? { ...c, date } : c,
                              ),
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
                              closures: form.closures.map((c, i) =>
                                i === index ? { ...c, note } : c,
                              ),
                            })
                          }
                        />
                      </FieldPair>
                    </div>
                    {editable ? (
                      <button
                        type="button"
                        className="g-btn g-btn-icon"
                        style={s('flex:none;margin-top:22px')}
                        aria-label={tr('settings.hours.closureRemove', { date: closure.date })}
                        onClick={() =>
                          setForm({
                            ...form,
                            closures: form.closures.filter((_, i) => i !== index),
                          })
                        }
                      >
                        <Gi n="x" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {problems.includes('closures') ? (
            <FieldMessage tone="bad">{tr('settings.hours.tooMany')}</FieldMessage>
          ) : null}
          {editable ? (
            <button
              type="button"
              className="g-btn"
              style={s('align-self:flex-start')}
              onClick={() =>
                setForm({ ...form, closures: [...form.closures, { date: '', note: '' }] })
              }
            >
              <Gi n="plus" size="sm" />
              {tr('settings.hours.closureAdd')}
            </button>
          ) : null}
        </fieldset>
      </FormCard>

      {hasOtherHoursRules(loaded.value) ? (
        <p className="g-t-c" style={s('margin:0')}>
          {tr('settings.hours.keptNote')}
        </p>
      ) : null}
      <SaveBar editable={editable} busy={busy} saving={saving} />
    </form>
  );
}
