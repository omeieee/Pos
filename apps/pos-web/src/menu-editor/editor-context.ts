import { createContext, useContext } from 'react';
import type { Costs, EditorOutcome } from './menu-editor-store.ts';

/** What a dialog is open for. A missing id means a new row. */
export type DialogTarget =
  | { kind: 'item'; categoryId: string; itemId?: string }
  | { kind: 'category'; id?: string }
  | { kind: 'group'; id?: string }
  | { kind: 'option'; groupId: string; id?: string };

export interface EditorContextValue {
  /** No connection: every control that would write is off. */
  offline: boolean;
  /** Estimated costs, only for roles that can see them; null for everyone else. */
  costs: Costs | null;
  /** Rows (and lists) with a request on their way. */
  pending: readonly string[];
  showArchived: boolean;
  open(target: DialogTarget): void;
  /** Puts a sentence at the top of the page (null clears it). */
  flash(text: string | null): void;
  /** Runs one store call; its failure is shown on the page. True when it worked. */
  run<T>(call: Promise<EditorOutcome<T>>): Promise<boolean>;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('EditorContext is missing');
  return value;
}
