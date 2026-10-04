import type { ReactNode } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useT } from '../ui/hooks.ts';
import { moveWithin } from './model.ts';
import './menu-glass.css';

const TINTS = ['peach', 'gold', 'rose', 'sky', 'sand', 'mint'] as const;

/** A steady tint for a dish tile, from its id (the canvas tints every dish differently). */
export function tintOf(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `g-tg-${TINTS[hash % TINTS.length]}`;
}

/** The round dish thumbnail of a row: the photo on a tint, or the bowl when there is no photo. */
export function Thumb({ id, src }: { id: string; src: string | null }) {
  return (
    <span className={`g-tile mthumb ${tintOf(id)}`} aria-hidden="true">
      <span className="g-ph">
        {src ? (
          <img className="g-photo" src={src} alt="" loading="lazy" width="56" height="56" />
        ) : (
          <Gi n="bowl" />
        )}
      </span>
    </span>
  );
}

/** The words-and-icon badges of a row (sold out, archived, off): never colour alone. */
export function RowBadge({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'mute' | 'ok' | 'info';
  icon: 'warn' | 'x' | 'check' | 'info' | 'lock';
  children: ReactNode;
}) {
  return (
    <span className={`g-badge g-b-${tone}`}>
      <Gi n={icon} />
      {children}
    </span>
  );
}

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
    <span style={s('display:inline-flex;gap:6px')}>
      <button
        type="button"
        className="g-btn gbtn-row mbtn-icon"
        aria-label={tr('menuEditor.moveUp', { name })}
        disabled={disabled || up === null}
        onClick={() => up && onMove(up)}
      >
        <Gi n="chevronUp" size="sm" />
      </button>
      <button
        type="button"
        className="g-btn gbtn-row mbtn-icon"
        aria-label={tr('menuEditor.moveDown', { name })}
        disabled={disabled || down === null}
        onClick={() => down && onMove(down)}
      >
        <Gi n="chevronDown" size="sm" />
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
    <label className="mesw">
      <span>{tr('menuEditor.soldOut')}</span>
      <input
        type="checkbox"
        role="switch"
        className="g-sw"
        aria-checked={soldOut}
        aria-label={tr('menuEditor.soldOut.for', { name })}
        checked={soldOut}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
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
    <span style={s('display:inline-flex;gap:6px')}>
      {onEdit ? (
        <button
          type="button"
          className="g-btn gbtn-row"
          aria-label={tr('menuEditor.edit.for', { name })}
          disabled={disabled}
          onClick={onEdit}
        >
          <Gi n="note" size="sm" />
          <span>{tr('menuEditor.edit')}</span>
        </button>
      ) : null}
      {archived ? (
        <button
          type="button"
          className="g-btn gbtn-row"
          aria-label={tr('menuEditor.restore.for', { name })}
          disabled={disabled}
          onClick={onRestore}
        >
          {tr('menuEditor.restore')}
        </button>
      ) : (
        <button
          type="button"
          className="g-btn gbtn-row"
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
