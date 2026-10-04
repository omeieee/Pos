import { useT } from '../ui/hooks.ts';
import './settings-glass.css';

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
    <div className="gsave">
      <button type="submit" className="g-btn g-btn-p g-btn-lg" disabled={busy || saving}>
        {saving ? tr('settings.saving') : tr('common.save')}
      </button>
    </div>
  );
}
