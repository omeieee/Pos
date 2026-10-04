import { useEffect, useState } from 'react';
import { FieldPair } from '../ui/FormParts.tsx';
import { useServices, useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { DialogFrame } from './DialogFrame.tsx';
import { useEditorContext } from './editor-context.ts';
import { groupRows, nextSort } from './lists.ts';
import { buildGroupCreate, buildGroupPatch, type GroupField, groupFormFrom } from './model.ts';
import { useSaver } from './use-saver.ts';

/** A new modifier group, or the name and the pick range of an existing one (its options have their own dialog). */
export function GroupDialog({ id, onClose }: { id?: string | undefined; onClose: () => void }) {
  const { menuEditor, entities } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const [base] = useState(() => (id ? entities.getState().groups.get(id) : undefined));
  const [form, setForm] = useState(() => groupFormFrom(base));
  const [problems, setProblems] = useState<GroupField[]>([]);
  const { saving, error, save } = useSaver(onClose);
  const missing = id !== undefined && base === undefined;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (missing) return null;

  async function submit() {
    if (!base) {
      const built = buildGroupCreate(form, nextSort(groupRows(entities.getState()).live));
      if (!built.ok) return setProblems(built.errors);
      setProblems([]);
      await save(menuEditor.createGroup(built.input));
      return;
    }
    const built = buildGroupPatch(base, form);
    if (!built.ok) return setProblems(built.errors);
    setProblems([]);
    if (!built.input) return onClose();
    await save(menuEditor.patchGroup(base.id, built.input));
  }

  return (
    <DialogFrame
      titleKey={base ? 'menuEditor.dialog.group.edit' : 'menuEditor.dialog.group.new'}
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
      <FieldPair>
        <TextField
          label={tr('menuEditor.field.minSelect')}
          value={form.minSelect}
          inputMode="numeric"
          maxLength={2}
          hint={tr('menuEditor.field.minHint')}
          error={problems.includes('minSelect') ? tr('menuEditor.error.minSelect') : undefined}
          onChange={(minSelect) => setForm({ ...form, minSelect })}
        />
        <TextField
          label={tr('menuEditor.field.maxSelect')}
          value={form.maxSelect}
          inputMode="numeric"
          maxLength={2}
          error={problems.includes('maxSelect') ? tr('menuEditor.error.maxSelect') : undefined}
          onChange={(maxSelect) => setForm({ ...form, maxSelect })}
        />
      </FieldPair>
    </DialogFrame>
  );
}
