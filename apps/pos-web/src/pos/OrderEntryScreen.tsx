import { formatBaht } from '@sds/i18n';
import { useCallback, useMemo, useState } from 'react';
import {
  useConnection,
  useEntities,
  useLocale,
  useServices,
  useStoreState,
  useT,
  useViewport,
} from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { CartPanel } from './CartPanel.tsx';
import { checkSelection, priceCart } from './cart-pricing.ts';
import { ModifierSheet, type SheetTarget } from './ModifierSheet.tsx';
import { buildMenu, findItem, type MenuItemView, matchesSearch } from './menu-model.ts';
import { localName } from './names.ts';
import { pruneSelection } from './selection.ts';

/** Same breakpoint as the shell: below it the navigation moves to the bottom and the order is a sheet. */
const PHONE_MAX_WIDTH = 719;

/**
 * Order entry (S1): the menu by category, tap a dish to add it, the order beside it (iPad,
 * laptop) or behind a bar at the bottom (iPhone). Tap a dish: one without required choices is
 * added at once; one with them repeats the last choices made for it, or opens the options sheet.
 */
export function OrderEntryScreen() {
  const { cart } = useServices();
  const entities = useEntities();
  const connection = useConnection();
  const cartState = useStoreState(cart);
  const tr = useT();
  const locale = useLocale();
  const phone = useViewport().width <= PHONE_MAX_WIDTH;

  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

  const { categories, items, groups, options } = entities;
  const menu = useMemo(
    () => buildMenu({ categories, items, groups, options }),
    [categories, items, groups, options],
  );
  const pricing = useMemo(() => priceCart(entities, cartState.lines), [entities, cartState.lines]);

  const activeCategory = menu.some((c) => c.id === category) ? category : 'all';
  const shown = menu
    .filter((c) => activeCategory === 'all' || c.id === activeCategory)
    .flatMap((c) => c.items)
    .filter((item) => matchesSearch(item, query));
  const totalDishes = menu.reduce((sum, c) => sum + c.items.length, 0);

  const inCart = new Map<string, number>();
  for (const line of cartState.lines) {
    inCart.set(line.itemId, (inCart.get(line.itemId) ?? 0) + line.qty);
  }
  const locked = cartState.phase !== 'editing';

  function pick(item: MenuItemView) {
    if (!item.orderable || locked) return;
    if (!item.groups.some((g) => g.required)) {
      cart.addItem({ itemId: item.id });
      return;
    }
    const last = pruneSelection(item.groups, cart.lastChoice(item.id) ?? []);
    if (last.length > 0 && checkSelection(entities, item.id, last).ok) {
      cart.addItem({ itemId: item.id, optionIds: last });
      return;
    }
    setSheet({ mode: 'add', itemId: item.id });
  }

  const closeSheet = useCallback(() => setSheet(null), []);
  const sheetItemId =
    sheet?.mode === 'add'
      ? sheet.itemId
      : sheet
        ? cartState.lines.find((l) => l.key === sheet.lineKey)?.itemId
        : undefined;
  const sheetItem = sheetItemId ? findItem(menu, sheetItemId) : undefined;

  function editLine(lineKey: string) {
    setCartOpen(false);
    setSheet({ mode: 'edit', lineKey });
  }

  const emptyMenuKey =
    totalDishes > 0
      ? null
      : connection.synced
        ? 'pos.orderEntry.menuEmpty'
        : connection.status === 'offline'
          ? 'pos.orderEntry.menuNotLoaded'
          : 'pos.orderEntry.menuLoading';

  return (
    <div className="oe">
      <section className="oe__menu" aria-label={tr('pos.orderEntry.title')}>
        <div className="oe__tools">
          <label className="oe__search">
            <Icon name="search" />
            <input
              className="input"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              aria-label={tr('common.search')}
              placeholder={tr('pos.orderEntry.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {totalDishes > 0 ? (
          <nav className="chips" aria-label={tr('pos.orderEntry.categories')}>
            <button
              type="button"
              className={activeCategory === 'all' ? 'cat cat--on' : 'cat'}
              aria-pressed={activeCategory === 'all'}
              onClick={() => setCategory('all')}
            >
              {`${tr('pos.orderEntry.all')} ${totalDishes}`}
            </button>
            {menu.map((c) => (
              <button
                key={c.id}
                type="button"
                className={activeCategory === c.id ? 'cat cat--on' : 'cat'}
                aria-pressed={activeCategory === c.id}
                onClick={() => setCategory(c.id)}
              >
                {`${localName(locale, c.nameTh, c.nameEn)} ${c.items.length}`}
              </button>
            ))}
          </nav>
        ) : null}

        {emptyMenuKey ? (
          <p className="oe__note muted" role="status">
            {tr(emptyMenuKey)}
          </p>
        ) : shown.length === 0 ? (
          <p className="oe__note muted" role="status">
            {tr('pos.orderEntry.noMatch')}
          </p>
        ) : (
          <ul className="dishes">
            {shown.map((item) => {
              const count = inCart.get(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.soldOut ? 'dish dish--sold' : 'dish'}
                    disabled={item.soldOut || locked}
                    onClick={() => pick(item)}
                  >
                    <span className="dish__art" aria-hidden="true">
                      <Icon name="bowl" />
                    </span>
                    <span className="dish__name">
                      {localName(locale, item.nameTh, item.nameEn)}
                    </span>
                    <span className="dish__price money">
                      {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
                    </span>
                    {count ? (
                      <span className="dish__qty">
                        <span aria-hidden="true">{count}</span>
                        <span className="visually-hidden">
                          {tr('pos.orderEntry.inCart', { count })}
                        </span>
                      </span>
                    ) : null}
                    {item.soldOut ? (
                      <span className="status status--danger dish__flag">
                        <Icon name="x" />
                        {tr('pos.orderEntry.soldOut')}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {phone ? null : (
        <aside className="oe__cart">
          <CartPanel onEditLine={editLine} />
        </aside>
      )}

      {phone && cartState.lines.length > 0 ? (
        <div className="oe__bar">
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => setCartOpen(true)}
          >
            <Icon name="cart" />
            <span>{tr('pos.orderEntry.viewOrder', { count: pricing.itemCount })}</span>
            <span className="oe__bar-total money">{formatBaht(pricing.totalSatang, locale)}</span>
          </button>
        </div>
      ) : null}

      {phone && cartOpen ? (
        <Modal labelledBy="cart-title" onClose={() => setCartOpen(false)} variant="cart">
          <CartPanel onClose={() => setCartOpen(false)} onEditLine={editLine} />
        </Modal>
      ) : null}

      {sheet && sheetItem ? (
        <ModifierSheet target={sheet} item={sheetItem} onClose={closeSheet} />
      ) : null}
    </div>
  );
}
