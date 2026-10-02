import { localName } from '../pos/names.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { useEditorContext } from './editor-context.ts';
import { categoryRows } from './lists.ts';
import { reorderKey, rowKey } from './menu-editor-store.ts';
import { MoveButtons, RowButtons } from './RowParts.tsx';

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
    <div className="medit__panel">
      <div className="medit__bar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={ctx.offline}
          onClick={() => ctx.open({ kind: 'category' })}
        >
          <Icon name="plus" />
          <span>{tr('menuEditor.add.category')}</span>
        </button>
      </div>
      {categories.length === 0 ? (
        <p className="muted medit__empty">{tr('menuEditor.empty.categories')}</p>
      ) : (
        <ul className="mlist">
          {categories.map((category) => {
            const name = localName(locale, category.nameTh, category.nameEn);
            const off = !category.active;
            return (
              <li key={category.id} className={`mrow${off ? ' mrow--archived' : ''}`}>
                <span className="mrow__main">
                  <span className="mrow__name">{name}</span>
                  {off ? <span className="tag">{tr('menuEditor.category.off')}</span> : null}
                </span>
                <span className="mrow__actions">
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
