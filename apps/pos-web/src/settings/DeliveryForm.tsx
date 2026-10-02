import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { TextField } from '../ui/TextField.tsx';
import { addBuilding, type BuildingError, buildDeliveryInput, removeBuilding } from './model.ts';
import { SaveBar } from './SaveBar.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

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
    <div className="sset__form">
      <p className="hint">{tr('settings.delivery.hint')}</p>
      <ul className="sset__chips" aria-label={tr('settings.delivery.list')}>
        {list.map((name) => (
          <li key={name} className="sset__chip">
            <span>{name}</span>
            {editable ? (
              <button
                type="button"
                className="btn btn-soft"
                aria-label={tr('settings.delivery.remove', { name })}
                disabled={list.length <= 1}
                onClick={() => change(removeBuilding(list, name), false)}
              >
                <Icon name="x" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          className="sset__add-row"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            change(addBuilding(list, draft), true);
          }}
        >
          <TextField
            label={tr('settings.delivery.name')}
            value={draft}
            maxLength={20}
            error={error ? tr(`settings.delivery.error.${error}`) : undefined}
            onChange={setDraft}
          />
          <button type="submit" className="btn btn-soft">
            <Icon name="plus" />
            {tr('settings.delivery.add')}
          </button>
        </form>
      ) : null}
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
