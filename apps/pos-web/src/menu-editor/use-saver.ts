import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { useEditorContext } from './editor-context.ts';
import type { EditorOutcome } from './menu-editor-store.ts';
import { failureText } from './outcome-text.ts';

/**
 * The save button of a dialog: runs one store call, closes the dialog when it worked, shows the
 * failure inside the dialog otherwise. After a stale view (the rows were read again) the dialog is
 * closed instead, because the form was built on rows that are no longer current: the sentence goes
 * to the page and the person opens the row again.
 */
export function useSaver(onClose: () => void) {
  const tr = useT();
  const ctx = useEditorContext();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save<T>(call: Promise<EditorOutcome<T>>): Promise<EditorOutcome<T>> {
    setSaving(true);
    setError(null);
    const outcome = await call;
    setSaving(false);
    if (outcome.ok) {
      onClose();
    } else {
      const text = failureText(tr, outcome);
      if (outcome.reason === 'error' && outcome.refreshed) {
        ctx.flash(text);
        onClose();
      } else {
        setError(text);
      }
    }
    return outcome;
  }

  return { saving, error, setError, save };
}
