import { useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { moveWithin } from './model.ts';

/**
 * The up and down buttons of a row. The list is the whole sibling set the server reorders: a move
 * sends all of it, so while one is on its way every move button of the list is off.
 */
export function MoveButtons({
  ids,
  id,
  name,
  disabled,
  onMove,
}: {
  ids: readonly string[];
  id: string;
  name: string;
  disabled: boolean;
  onMove: (order: string[]) => void;
}) {
  const tr = useT();
  const up = moveWithin(ids, id, 'up');
  const down = moveWithin(ids, id, 'down');
  return (
    <span className="mrow__move">
      <button
        type="button"
        className="btn btn-soft"
        aria-label={tr('menuEditor.moveUp', { name })}
        disabled={disabled || up === null}
        onClick={() => up && onMove(up)}
      >
        <span aria-hidden="true">▲</span>
      </button>
      <button
        type="button"
        className="btn btn-soft"
        aria-label={tr('menuEditor.moveDown', { name })}
        disabled={disabled || down === null}
        onClick={() => down && onMove(down)}
      >
        <span aria-hidden="true">▼</span>
      </button>
    </span>
  );
}

/** The sold-out switch (หมด): on means sold out. */
export function SoldOutSwitch({
  name,
  soldOut,
  disabled,
  onChange,
}: {
  name: string;
  soldOut: boolean;
  disabled: boolean;
  onChange: (soldOut: boolean) => void;
}) {
  const tr = useT();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={soldOut}
      aria-label={tr('menuEditor.soldOut.for', { name })}
      className={`mswitch${soldOut ? ' mswitch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!soldOut)}
    >
      <span className="mswitch__track" aria-hidden="true">
        <span className="mswitch__knob" />
      </span>
      <span>{tr('menuEditor.soldOut')}</span>
    </button>
  );
}

/** Edit and archive (or restore) of one row. */
export function RowButtons({
  name,
  archived,
  disabled,
  onEdit,
  onArchive,
  onRestore,
}: {
  name: string;
  archived: boolean;
  disabled: boolean;
  onEdit?: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const tr = useT();
  return (
    <span className="mrow__buttons">
      {onEdit ? (
        <button
          type="button"
          className="btn btn-soft"
          aria-label={tr('menuEditor.edit.for', { name })}
          disabled={disabled}
          onClick={onEdit}
        >
          <Icon name="note" />
          <span>{tr('menuEditor.edit')}</span>
        </button>
      ) : null}
      {archived ? (
        <button
          type="button"
          className="btn btn-soft"
          aria-label={tr('menuEditor.restore.for', { name })}
          disabled={disabled}
          onClick={onRestore}
        >
          {tr('menuEditor.restore')}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-soft"
          aria-label={tr('menuEditor.archive.for', { name })}
          disabled={disabled}
          onClick={onArchive}
        >
          {tr('menuEditor.archive')}
        </button>
      )}
    </span>
  );
}
