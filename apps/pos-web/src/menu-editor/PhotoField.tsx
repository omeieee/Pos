import { type ChangeEvent, useId, useState } from 'react';
import { apiUrl } from '../platform/config.ts';
import { useEntities, useServices, useT } from '../ui/hooks.ts';
import { useEditorContext } from './editor-context.ts';
import { rowKey } from './menu-editor-store.ts';
import { failureText } from './outcome-text.ts';

/**
 * The photo of an existing dish: shows it, picks a new one, removes it. A picked file is never
 * uploaded as it is: the store re-encodes it first (`photo-plan.ts`), which drops the camera's
 * location data. `onChanged` gets the item's new version so the open form keeps matching it.
 */
export function PhotoField({
  itemId,
  onChanged,
}: {
  itemId: string;
  onChanged: (version: number) => void;
}) {
  const { menuEditor } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const inputId = useId();
  const item = useEntities().items.get(itemId);
  const [error, setError] = useState<string | null>(null);
  const working = ctx.pending.includes(rowKey(itemId));
  if (!item) return null;
  const hasPhoto = Boolean(item.photoUrl);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // So the same file can be chosen again after a failure.
    event.target.value = '';
    if (!file) return;
    setError(null);
    const outcome = await menuEditor.setPhoto({ id: itemId }, file);
    if (outcome.ok) onChanged(outcome.value.version);
    else setError(failureText(tr, outcome));
  }

  async function remove() {
    setError(null);
    const outcome = await menuEditor.removePhoto({ id: itemId });
    if (outcome.ok) onChanged(outcome.value.version);
    else setError(failureText(tr, outcome));
  }

  return (
    <fieldset className="group mphoto">
      <legend className="label">{tr('menuEditor.photo.title')}</legend>
      <div className="mphoto__row">
        <span className="mphoto__frame">
          {item.photoUrl ? (
            <img
              src={apiUrl(item.photoUrl)}
              alt={tr('menuEditor.photo.alt', { name: item.nameTh })}
              width="120"
              height="120"
            />
          ) : null}
        </span>
        <div className="mphoto__buttons">
          <label
            htmlFor={inputId}
            className={`btn btn-soft${ctx.offline || working ? ' btn--off' : ''}`}
            aria-disabled={ctx.offline || working}
          >
            {working
              ? tr('menuEditor.photo.working')
              : tr(hasPhoto ? 'menuEditor.photo.change' : 'menuEditor.photo.choose')}
          </label>
          <input
            id={inputId}
            className="visually-hidden"
            type="file"
            accept="image/*"
            disabled={ctx.offline || working}
            onChange={(event) => void pick(event)}
          />
          {hasPhoto ? (
            <button
              type="button"
              className="btn btn-soft"
              disabled={ctx.offline || working}
              onClick={() => void remove()}
            >
              {tr('menuEditor.photo.remove')}
            </button>
          ) : null}
        </div>
      </div>
      <p className="hint">{tr('menuEditor.photo.hint')}</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
