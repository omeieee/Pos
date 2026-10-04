import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { addBuilding, type BuildingError, buildDeliveryInput, removeBuilding } from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';
import './settings-glass.css';

/** The buildings the shop delivers to: add, remove, then save the whole list. */
export function DeliveryForm({
  loaded,
  editable,
  saving,
  busy,
  submit,
}: SectionBodyProps<'delivery'>) {
  const tr = useT();
  const [list, setList] = useState<string[]>(() => [...loaded.value.buildings]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<BuildingError | null>(null);

  function change(result: ReturnType<typeof addBuilding>, clearDraft: boolean) {
    if (result.ok) {
      setList(result.list);
      setError(null);
      if (clearDraft) setDraft('');
    } else {
      setError(result.error);
    }
  }

  // Two forms side by side: Enter in the name box adds the building, and only the Save button
  // saves the list.
  return (
    <div style={s('display:flex;flex-direction:column;gap:18px')}>
      <FormCard>
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.delivery.hint')}
        </p>
        <ul
          className="gset-list"
          style={s('display:flex;flex-wrap:wrap;gap:8px')}
          aria-label={tr('settings.delivery.list')}
        >
          {list.map((name) => (
            <li key={name} className="gset-chipx">
              <span>{name}</span>
              {editable ? (
                <button
                  type="button"
                  aria-label={tr('settings.delivery.remove', { name })}
                  disabled={list.length <= 1}
                  onClick={() => change(removeBuilding(list, name), false)}
                >
                  <Gi n="x" size="sm" />
                </button>
              ) : (
                <span style={s('width:12px')} />
              )}
            </li>
          ))}
        </ul>
        {editable ? (
          <form
            className="gset-addrow"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              change(addBuilding(list, draft), true);
            }}
          >
            <TextField
              icon="building"
              label={tr('settings.delivery.name')}
              value={draft}
              maxLength={20}
              error={error ? tr(`settings.delivery.error.${error}`) : undefined}
              onChange={setDraft}
            />
            <button type="submit" className="g-btn">
              <Gi n="plus" size="sm" />
              {tr('settings.delivery.add')}
            </button>
          </form>
        ) : null}
      </FormCard>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(buildDeliveryInput(loaded.value, loaded.version, list));
        }}
      >
        <SaveBar editable={editable} busy={busy} saving={saving} />
      </form>
    </div>
  );
}
