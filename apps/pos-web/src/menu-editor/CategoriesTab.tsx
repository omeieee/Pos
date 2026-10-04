import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { localName } from '../pos/names.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { useEditorContext } from './editor-context.ts';
import { categoryRows } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowBadge, RowButtons } from './RowParts.tsx';
import './menu-glass.css';

/**
 * The categories, every one in a single list (the server reorders all of them together). A switched-off
 * category hides its dishes from the menu; "archive" here switches it off and "restore" switches it on.
 */
export function CategoriesTab() {
  const tr = useT();
  const locale = useLocale();
  const { menuEditor } = useServices();
  const ctx = useEditorContext();
  const categories = categoryRows(useEntities());
  const ids = categories.map((c) => c.id);
  const listBusy = ctx.pending.includes(reorderKey('categories', undefined));

  return (
    <div style={s('display:flex;flex-direction:column;gap:16px;min-width:0')}>
      <div>
        <button
          type="button"
          className="g-btn g-btn-p"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'category' })}
        >
          <Gi n="plus" size="sm" />
          <span>{tr('menuEditor.add.category')}</span>
        </button>
      </div>
      {categories.length === 0 ? (
        <p className="g-t-s" style={s('margin:0')}>
          {tr('menuEditor.empty.categories')}
        </p>
      ) : (
        <ul className="g-glass gset-grp gset-list">
          {categories.map((category) => {
            const name = localName(locale, category.nameTh, category.nameEn);
            const off = !category.active;
            return (
              <li key={category.id} className={`g-row merow${off ? ' merow--archived' : ''}`}>
                <span className="merow__main">
                  <span className="merow__name">{name}</span>
                  {off ? (
                    <span className="merow__badges">
                      <RowBadge tone="mute" icon="x">
                        {tr('menuEditor.category.off')}
                      </RowBadge>
                    </span>
                  ) : null}
                </span>
                <span className="merow__actions">
                  <MoveButtons
                    ids={ids}
                    id={category.id}
                    name={name}
                    disabled={ctx.offline || listBusy}
                    onMove={(order) =>
                      void ctx.run(menuEditor.reorder('categories', undefined, order))
                    }
                  />
                  <RowButtons
                    name={name}
                    archived={off}
                    disabled={ctx.offline || ctx.pending.includes(rowKey(category.id))}
                    onEdit={() => ctx.open({ kind: 'category', id: category.id })}
                    onArchive={() => void ctx.run(menuEditor.setCategoryActive(category, false))}
                    onRestore={() => void ctx.run(menuEditor.setCategoryActive(category, true))}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
