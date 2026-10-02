import { useEffect, useState } from 'react';
import { useServices, useT } from '../ui/hooks.ts';
import { TextField } from '../ui/TextField.tsx';
import { DialogFrame } from './DialogFrame.tsx';
import { useEditorContext } from './editor-context.ts';
import { categoryRows, nextSort } from './lists.ts';
import {
  buildCategoryCreate,
  buildCategoryPatch,
  categoryFormFrom,
  validateCategoryForm,
} from './model.ts';
import { useSaver } from './use-saver.ts';

/** A new category, or the names of an existing one. The row is read once, when the dialog opens: the version it carries is the one a save is checked against. */
export function CategoryDialog({ id, onClose }: { id?: string | undefined; onClose: () => void }) {
  const { menuEditor, entities } = useServices();
  const ctx = useEditorContext();
  const tr = useT();
  const [base] = useState(() => (id ? entities.getState().categories.get(id) : undefined));
  const [form, setForm] = useState(() => categoryFormFrom(base));
  const [tried, setTried] = useState(false);
  const { saving, error, save } = useSaver(onClose);
  const missing = id !== undefined && base === undefined;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (missing) return null;

  const problems = tried ? validateCategoryForm(form) : [];

  async function submit() {
    setTried(true);
    if (validateCategoryForm(form).length > 0) return;
    if (!base) {
      const sort = nextSort(categoryRows(entities.getState()));
      await save(menuEditor.createCategory(buildCategoryCreate(form, sort)));
      return;
    }
    const patch = buildCategoryPatch(base, form);
    if (!patch) return onClose();
    await save(menuEditor.patchCategory(base.id, patch));
  }

  return (
    <DialogFrame
      titleKey={base ? 'menuEditor.dialog.category.edit' : 'menuEditor.dialog.category.new'}
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
    </DialogFrame>
  );
}
