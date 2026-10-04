import { useCallback, useEffect, useMemo, useState } from 'react';
import { s } from '../design/style.ts';
import { SettingsPage } from '../settings/SettingsPage.tsx';
import { CheckChip, SegRadio } from '../ui/FormParts.tsx';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { CategoriesTab } from './CategoriesTab.tsx';
import { CategoryDialog } from './CategoryDialog.tsx';
import { type DialogTarget, EditorContext, type EditorContextValue } from './editor-context.ts';
import { GroupDialog } from './GroupDialog.tsx';
import { GroupsTab } from './GroupsTab.tsx';
import { ItemDialog } from './ItemDialog.tsx';
import { ItemsTab } from './ItemsTab.tsx';
import { OptionDialog } from './OptionDialog.tsx';
import './menu-glass.css';
import { failureText } from './outcome-text.ts';

const TABS = ['items', 'categories', 'groups'] as const;
type Tab = (typeof TABS)[number];

/**
 * The menu editor (Settings > Menu): dishes, categories and option groups, with prices per
 * channel, the sold-out switch, archive and restore, and the order of each list. Online only: with
 * no connection the lists stay readable and every control that would write is off, with a plain
 * explanation (an edit is never saved for later). The estimated costs show only to roles that can
 * see reports.
 */
export function MenuEditorScreen() {
  const { menuEditor, outbox } = useServices();
  const editor = useStoreState(menuEditor);
  const offline = useStoreState(outbox).offline;
  const tr = useT();
  const [tab, setTab] = useState<Tab>('items');
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Read the menu (with archived rows and costs) when the page opens and whenever the connection
  // comes back. While offline the saved menu on the device is what shows.
  useEffect(() => {
    if (!offline) void menuEditor.load();
  }, [menuEditor, offline]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const value = useMemo<EditorContextValue>(
    () => ({
      offline,
      costs: editor.costs,
      pending: editor.pending,
      showArchived,
      open: (target) => {
        setMessage(null);
        setDialog(target);
      },
      flash: setMessage,
      async run(call) {
        setMessage(null);
        const outcome = await call;
        if (outcome.ok) return true;
        setMessage(failureText(tr, outcome));
        return false;
      },
    }),
    [offline, editor.costs, editor.pending, showArchived, tr],
  );

  return (
    <EditorContext.Provider value={value}>
      <SettingsPage labelledBy="medit-page-title" maxWidth={860}>
        <header
          style={s(
            'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px',
          )}
        >
          <h1 id="medit-page-title" className="g-t-1" style={s('margin:0')}>
            {tr('menuEditor.title')}
          </h1>
          <CheckChip
            label={tr('menuEditor.showArchived')}
            checked={showArchived}
            onChange={setShowArchived}
          />
        </header>

        {offline ? (
          <Callout tone="warn" role="status">
            {tr('menuEditor.offline')}
          </Callout>
        ) : null}

        {message ? (
          <Callout tone="bad" role="alert">
            {message}
          </Callout>
        ) : null}

        <SegRadio
          legend={tr('menuEditor.tabs')}
          name="menu-editor-tab"
          value={tab}
          options={TABS.map((id) => ({ value: id, label: tr(`menuEditor.tab.${id}`) }))}
          onChange={setTab}
        />

        {editor.status === 'loading' ? (
          <p className="g-t-s" style={s('margin:0')} role="status">
            {tr('menuEditor.loading')}
          </p>
        ) : null}
        {editor.status === 'error' ? (
          <Callout
            tone="bad"
            role="alert"
            action={
              <button
                type="button"
                className="g-btn gbtn-row"
                disabled={offline}
                onClick={() => void menuEditor.load()}
              >
                {tr('common.retry')}
              </button>
            }
          >
            {tr('menuEditor.loadFailed')}
          </Callout>
        ) : null}

        {editor.costsFailed ? (
          <Callout
            tone="bad"
            role="alert"
            action={
              <button
                type="button"
                className="g-btn gbtn-row"
                disabled={offline}
                onClick={() => void menuEditor.load()}
              >
                {tr('common.retry')}
              </button>
            }
          >
            {tr('menuEditor.costsFailed')}
          </Callout>
        ) : null}

        {tab === 'items' ? <ItemsTab /> : null}
        {tab === 'categories' ? <CategoriesTab /> : null}
        {tab === 'groups' ? <GroupsTab /> : null}

        {dialog?.kind === 'item' ? (
          <ItemDialog categoryId={dialog.categoryId} itemId={dialog.itemId} onClose={closeDialog} />
        ) : null}
        {dialog?.kind === 'category' ? (
          <CategoryDialog id={dialog.id} onClose={closeDialog} />
        ) : null}
        {dialog?.kind === 'group' ? <GroupDialog id={dialog.id} onClose={closeDialog} /> : null}
        {dialog?.kind === 'option' ? (
          <OptionDialog groupId={dialog.groupId} id={dialog.id} onClose={closeDialog} />
        ) : null}
      </SettingsPage>
    </EditorContext.Provider>
  );
}
