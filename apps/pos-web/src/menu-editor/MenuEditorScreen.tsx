import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { CategoriesTab } from './CategoriesTab.tsx';
import { CategoryDialog } from './CategoryDialog.tsx';
import { type DialogTarget, EditorContext, type EditorContextValue } from './editor-context.ts';
import { GroupDialog } from './GroupDialog.tsx';
import { GroupsTab } from './GroupsTab.tsx';
import { ItemDialog } from './ItemDialog.tsx';
import { ItemsTab } from './ItemsTab.tsx';
import { OptionDialog } from './OptionDialog.tsx';
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
      <section className="medit" aria-labelledby="medit-page-title">
        <header className="medit__head">
          <h1 id="medit-page-title" className="medit__title">
            {tr('menuEditor.title')}
          </h1>
          <label className="pick medit__archived">
            <input
              className="visually-hidden"
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            {tr('menuEditor.showArchived')}
          </label>
        </header>

        {offline ? (
          <p className="notice" role="status">
            <Icon name="wifi-off" />
            <span>{tr('menuEditor.offline')}</span>
          </p>
        ) : null}

        {message ? (
          <p className="error medit__message" role="alert">
            {message}
          </p>
        ) : null}

        <fieldset className="seg medit__tabs">
          <legend className="visually-hidden">{tr('menuEditor.tabs')}</legend>
          {TABS.map((id) => (
            <label key={id} className={`seg__item${tab === id ? ' seg__item--on' : ''}`}>
              <input
                className="visually-hidden"
                type="radio"
                name="menu-editor-tab"
                checked={tab === id}
                onChange={() => setTab(id)}
              />
              {tr(`menuEditor.tab.${id}`)}
            </label>
          ))}
        </fieldset>

        {editor.status === 'loading' ? (
          <p className="muted medit__empty" role="status">
            {tr('menuEditor.loading')}
          </p>
        ) : null}
        {editor.status === 'error' ? (
          <div className="notice" role="alert">
            <Icon name="alert" />
            <span>{tr('menuEditor.loadFailed')}</span>
            <button
              type="button"
              className="btn btn-soft"
              disabled={offline}
              onClick={() => void menuEditor.load()}
            >
              {tr('common.retry')}
            </button>
          </div>
        ) : null}

        {editor.costsFailed ? (
          <div className="notice" role="alert">
            <Icon name="alert" />
            <span>{tr('menuEditor.costsFailed')}</span>
            <button
              type="button"
              className="btn btn-soft"
              disabled={offline}
              onClick={() => void menuEditor.load()}
            >
              {tr('common.retry')}
            </button>
          </div>
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
      </section>
    </EditorContext.Provider>
  );
}
