import { MENU_CHANNELS, type MenuChannel } from '@sds/shared';
import { useEffect, useId, useState } from 'react';
import { localName } from '../pos/names.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { DialogFrame } from './DialogFrame.tsx';
import { useEditorContext } from './editor-context.ts';
import { categoryRows, groupRows, itemRowsOf, nextSort } from './lists.ts';
import {
  buildItemCreate,
  buildItemPatch,
  type ItemField,
  itemFormFrom,
  validateItemForm,
} from './model.ts';
import { PhotoField } from './PhotoField.tsx';
import { useSaver } from './use-saver.ts';

/**
 * A new dish, or an existing one. The row is read once when the dialog opens: its version is the
 * one a save is checked against, so a change made on another device meanwhile is refused (409)
 * instead of being overwritten. A save sends only the fields that were edited, and the cost
 * only if the person can see costs and edited it.
 */
export function ItemDialog({
  categoryId,
  itemId,
  onClose,
}: {
  categoryId: string;
  itemId?: string | undefined;
  onClose: () => void;
}) {
  const { menuEditor, entities } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const locale = useLocale();
  const state = useEntities();
  const withCost = ctx.costs !== null;
  const [base, setBase] = useState(() =>
    itemId ? entities.getState().items.get(itemId) : undefined,
  );
  const [originalCost] = useState(() => (itemId ? (ctx.costs?.items[itemId] ?? null) : null));
  const [form, setForm] = useState(() => itemFormFrom(base, categoryId, originalCost));
  const [tried, setTried] = useState(false);
  const { saving, error, save } = useSaver(onClose);
  const groupId = useId();
  const missing = itemId !== undefined && base === undefined;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (missing) return null;

  const problems: ItemField[] = tried ? validateItemForm(form, { withCost }) : [];
  const categories = categoryRows(state);
  const groups = groupRows(state).live;

  function toggleChannel(channel: MenuChannel) {
    const on = form.channels.includes(channel);
    setForm({
      ...form,
      channels: on ? form.channels.filter((c) => c !== channel) : [...form.channels, channel],
    });
  }

  function toggleGroup(id: string) {
    const on = form.modifierGroupIds.includes(id);
    setForm({
      ...form,
      modifierGroupIds: on
        ? form.modifierGroupIds.filter((g) => g !== id)
        : [...form.modifierGroupIds, id],
    });
  }

  async function submit() {
    setTried(true);
    if (validateItemForm(form, { withCost }).length > 0) return;
    if (!base) {
      const sort = nextSort(itemRowsOf(entities.getState(), form.categoryId).live);
      await save(menuEditor.createItem(buildItemCreate(form, { withCost, sort })));
      return;
    }
    const patch = buildItemPatch(base, originalCost, form, { withCost });
    if (!patch) return onClose();
    await save(menuEditor.patchItem(base.id, patch));
  }

  const fieldError = (field: ItemField, key: Parameters<typeof tr>[0]) =>
    problems.includes(field) ? tr(key) : undefined;

  return (
    <DialogFrame
      titleKey={base ? 'menuEditor.dialog.item.edit' : 'menuEditor.dialog.item.new'}
      saving={saving}
      disabled={ctx.offline}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={tr('menuEditor.field.nameTh')}
        value={form.nameTh}
        maxLength={80}
        error={fieldError('nameTh', 'menuEditor.error.nameTh')}
        onChange={(nameTh) => setForm({ ...form, nameTh })}
      />
      <TextField
        label={tr('menuEditor.field.nameEn')}
        value={form.nameEn}
        maxLength={80}
        hint={tr('menuEditor.field.optional')}
        onChange={(nameEn) => setForm({ ...form, nameEn })}
      />

      <div className="field-group">
        <label className="label" htmlFor={`${groupId}-category`}>
          {tr('menuEditor.category.pick')}
        </label>
        <select
          id={`${groupId}-category`}
          className="input"
          value={form.categoryId}
          onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {localName(locale, c.nameTh, c.nameEn)}
            </option>
          ))}
        </select>
        {problems.includes('categoryId') ? (
          <p className="error" role="alert">
            {tr('menuEditor.error.categoryId')}
          </p>
        ) : null}
      </div>

      <div className="mdialog__pair">
        <TextField
          label={tr('menuEditor.field.price')}
          value={form.price}
          inputMode="decimal"
          error={fieldError('price', 'menuEditor.error.price')}
          onChange={(price) => setForm({ ...form, price })}
        />
        {withCost ? (
          <TextField
            label={tr('menuEditor.field.cost')}
            value={form.cost}
            inputMode="decimal"
            hint={tr('menuEditor.field.costHint')}
            error={fieldError('cost', 'menuEditor.error.cost')}
            onChange={(cost) => setForm({ ...form, cost })}
          />
        ) : null}
      </div>

      <fieldset className="group">
        <legend className="label">{tr('menuEditor.field.channels')}</legend>
        <div className="picks">
          {MENU_CHANNELS.map((channel) => {
            const on = form.channels.includes(channel);
            return (
              <label key={channel} className={`pick${on ? ' pick--on' : ''}`}>
                <input
                  className="visually-hidden"
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleChannel(channel)}
                />
                {tr(`orders.channel.${channel}`)}
              </label>
            );
          })}
        </div>
        {problems.includes('channels') ? (
          <p className="error" role="alert">
            {tr('menuEditor.error.channels')}
          </p>
        ) : null}
      </fieldset>

      <div className="mdialog__prices">
        {MENU_CHANNELS.map((channel) => (
          <TextField
            key={channel}
            label={tr('menuEditor.field.channelPrice', {
              channel: tr(`orders.channel.${channel}`),
            })}
            value={form.channelPrices[channel]}
            inputMode="decimal"
            error={fieldError(`channelPrice.${channel}`, 'menuEditor.error.channelPrice')}
            onChange={(text) =>
              setForm({ ...form, channelPrices: { ...form.channelPrices, [channel]: text } })
            }
          />
        ))}
      </div>

      <TextField
        label={tr('menuEditor.field.descriptionTh')}
        value={form.descriptionTh}
        maxLength={500}
        hint={tr('menuEditor.field.optional')}
        onChange={(descriptionTh) => setForm({ ...form, descriptionTh })}
      />
      <TextField
        label={tr('menuEditor.field.descriptionEn')}
        value={form.descriptionEn}
        maxLength={500}
        hint={tr('menuEditor.field.optional')}
        onChange={(descriptionEn) => setForm({ ...form, descriptionEn })}
      />

      <fieldset className="group">
        <legend className="label">{tr('menuEditor.field.groups')}</legend>
        {groups.length === 0 ? (
          <p className="hint">{tr('menuEditor.field.groupsNone')}</p>
        ) : (
          <div className="picks">
            {groups.map((group) => {
              const on = form.modifierGroupIds.includes(group.id);
              return (
                <label key={group.id} className={`pick${on ? ' pick--on' : ''}`}>
                  <input
                    className="visually-hidden"
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleGroup(group.id)}
                  />
                  {localName(locale, group.nameTh, group.nameEn)}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      {base ? (
        <PhotoField
          itemId={base.id}
          onChanged={(version) =>
            setBase((current) => (current ? { ...current, version } : current))
          }
        />
      ) : (
        <p className="hint">{tr('menuEditor.photo.saveFirst')}</p>
      )}
    </DialogFrame>
  );
}
