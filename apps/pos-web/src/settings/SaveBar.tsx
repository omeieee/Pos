import { useT } from '../ui/hooks.ts';

/** The save button of a settings form. Off when the person may only look, offline, or while saving. */
export function SaveBar({
  editable,
  busy,
  saving,
}: {
  editable: boolean;
  busy: boolean;
  saving: boolean;
}) {
  const tr = useT();
  if (!editable) return null;
  return (
    <div className="sset__actions">
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy || saving}>
        {saving ? tr('settings.saving') : tr('common.save')}
      </button>
    </div>
  );
}
