import { useEffect, useState } from 'react';
import { groupsWithOptions } from '../realtime/selectors.ts';
import { useServices, useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { DialogFrame } from './DialogFrame.tsx';
import { useEditorContext } from './editor-context.ts';
import { nextSort, optionRowsOf } from './lists.ts';
import { buildOptionCreate, buildOptionPatch, type OptionField, optionFormFrom } from './model.ts';
import { useSaver } from './use-saver.ts';

/**
 * One option of a group: names, the price change (signed baht) and, for roles that see costs, the
 * cost change. A role without costs has no cost field, so a save from it can never overwrite one.
 */
export function OptionDialog({
  groupId,
  id,
  onClose,
}: {
  groupId: string;
  id?: string | undefined;
  onClose: () => void;
}) {
  const { menuEditor, entities } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const withCost = ctx.costs !== null;
  const [base] = useState(() => (id ? entities.getState().options.get(id) : undefined));
  const [originalCost] = useState(() => (id ? (ctx.costs?.options[id] ?? null) : null));
  const [form, setForm] = useState(() => optionFormFrom(base, originalCost));
  const [problems, setProblems] = useState<OptionField[]>([]);
  const { saving, error, save } = useSaver(onClose);
  const missing = id !== undefined && base === undefined;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (missing) return null;

  async function submit() {
    if (!base) {
      const group = groupsWithOptions(entities.getState()).get(groupId);
      const sort = nextSort(group ? optionRowsOf(group).live : []);
      const built = buildOptionCreate(form, { withCost, sort });
      if (!built.ok) return setProblems(built.errors);
      setProblems([]);
      await save(menuEditor.createOption(groupId, built.input));
      return;
    }
    const built = buildOptionPatch(base, originalCost, form, { withCost });
    if (!built.ok) return setProblems(built.errors);
    setProblems([]);
    if (!built.input) return onClose();
    await save(menuEditor.patchOption(base.id, built.input));
  }

  return (
    <DialogFrame
      titleKey={base ? 'menuEditor.dialog.option.edit' : 'menuEditor.dialog.option.new'}
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
        error={problems.includes('nameTh') ? tr('menuEditor.error.nameTh') : undefined}
        onChange={(nameTh) => setForm({ ...form, nameTh })}
      />
      <TextField
        label={tr('menuEditor.field.nameEn')}
        value={form.nameEn}
        maxLength={80}
        hint={tr('menuEditor.field.optional')}
        onChange={(nameEn) => setForm({ ...form, nameEn })}
      />
      <TextField
        label={tr('menuEditor.field.priceDelta')}
        value={form.priceDelta}
        hint={tr('menuEditor.field.priceDeltaHint')}
        error={problems.includes('priceDelta') ? tr('menuEditor.error.priceDelta') : undefined}
        onChange={(priceDelta) => setForm({ ...form, priceDelta })}
      />
      {withCost ? (
        <TextField
          label={tr('menuEditor.field.costDelta')}
          value={form.costDelta}
          hint={tr('menuEditor.field.costHint')}
          error={problems.includes('costDelta') ? tr('menuEditor.error.costDelta') : undefined}
          onChange={(costDelta) => setForm({ ...form, costDelta })}
        />
      ) : null}
    </DialogFrame>
  );
}
