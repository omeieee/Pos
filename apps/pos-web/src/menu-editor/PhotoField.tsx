import { type ChangeEvent, useId, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { apiUrl } from '../platform/config.ts';
import { useEntities, useServices, useT } from '../ui/hooks.ts';
import { FieldMessage } from '../ui/TextField.tsx';
import { useEditorContext } from './editor-context.ts';
import { rowKey } from './menu-editor-store.ts';
import { failureText } from './outcome-text.ts';
import { Thumb } from './RowParts.tsx';
import './menu-glass.css';

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

  const off = ctx.offline || working;
  return (
    <fieldset className="gset mephoto">
      <legend>{tr('menuEditor.photo.title')}</legend>
      <div style={s('display:flex;align-items:center;gap:16px;flex-wrap:wrap')}>
        {item.photoUrl ? (
          <span
            className="g-tile mthumb g-tg-sand"
            style={s('width:96px;height:96px;border-radius:24px')}
          >
            <span className="g-ph" style={s('border-radius:24px')}>
              <img
                className="g-photo"
                src={apiUrl(item.photoUrl)}
                alt={tr('menuEditor.photo.alt', { name: item.nameTh })}
                width="96"
                height="96"
              />
            </span>
          </span>
        ) : (
          <Thumb id={item.id} src={null} />
        )}
        <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
          <input
            id={inputId}
            className="gvh"
            type="file"
            accept="image/*"
            disabled={off}
            onChange={(event) => void pick(event)}
          />
          <label
            htmlFor={inputId}
            className="g-btn gbtn-row"
            aria-disabled={off}
            style={off ? s('opacity:.5;cursor:not-allowed') : undefined}
          >
            <Gi n="camera" size="sm" />
            {working
              ? tr('menuEditor.photo.working')
              : tr(hasPhoto ? 'menuEditor.photo.change' : 'menuEditor.photo.choose')}
          </label>
          {hasPhoto ? (
            <button
              type="button"
              className="g-btn gbtn-row"
              disabled={off}
              onClick={() => void remove()}
            >
              {tr('menuEditor.photo.remove')}
            </button>
          ) : null}
        </div>
      </div>
      <FieldMessage tone="hint">{tr('menuEditor.photo.hint')}</FieldMessage>
      <FieldMessage tone="hint">{tr('menuEditor.photo.savedNow')}</FieldMessage>
      {error ? <FieldMessage tone="bad">{error}</FieldMessage> : null}
    </fieldset>
  );
}
