import { formatBaht } from '@sds/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { weekdayDate } from '../design/format.ts';
import { Gi } from '../design/icons.tsx';
import { useLayout } from '../design/layout.ts';
import { PageHeader } from '../design/PageHeader.tsx';
import { s } from '../design/style.ts';
import {
  useConnection,
  useEntities,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { OutboxPill, SyncPill } from '../ui/SyncPill.tsx';
import { CartPanel } from './CartPanel.tsx';
import { CatalogueNotice } from './CatalogueNotice.tsx';
import { checkSelection, priceCart } from './cart-pricing.ts';
import type { CartMode } from './cart-store.ts';
import { dishArt, dishArtUrl } from './dish-art.ts';
import { ModifierSheet, type SheetTarget } from './ModifierSheet.tsx';
import { buildMenu, findItem, type MenuItemView, matchesSearch } from './menu-model.ts';
import { localName } from './names.ts';
import { pruneSelection } from './selection.ts';
import { useCart } from './use-cart.ts';
import { useStorefrontHours } from './use-storefront-hours.ts';

/**
 * Order entry (S1): the menu by category, tap a dish to add it, the order beside it (iPad,
 * laptop) or behind a bar at the bottom (iPhone). Tap a dish: one with no choices to offer is
 * added at once; one with required choices repeats the last choices made for it, or opens the
 * options sheet; one with only optional choices always opens the sheet.
 */
export function OrderEntryScreen({ mode = 'storefront' }: { mode?: CartMode }) {
  const { recipients } = useServices();
  const cart = useCart(mode);
  const platform = mode === 'platform';
  const entities = useEntities();
  const connection = useConnection();
  const cartState = useStoreState(cart);
  const tr = useT();
  const locale = useLocale();
  const phone = useLayout() === 'phone';
  const now = useNow(60_000);
  const hours = useStorefrontHours();

  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  // The remembered recipients and the buildings are read when the screen opens.
  useEffect(() => {
    if (platform) return;
    void recipients.refresh();
    void recipients.ensureBuildings();
  }, [recipients, platform]);

  const { categories, items, groups, options } = entities;
  const menu = useMemo(
    () => buildMenu({ categories, items, groups, options }, cartState.channel),
    [categories, items, groups, options, cartState.channel],
  );
  const pricing = useMemo(
    () => priceCart(entities, cartState.lines, cartState.channel),
    [entities, cartState.lines, cartState.channel],
  );

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
    if (!item.groups.some((g) => g.options.some((o) => o.available))) {
      cart.addItem({ itemId: item.id });
      return;
    }
    // Repeating the last choices is only for dishes that must have choices; a dish with optional
    // choices only asks every time, so an extra egg is never added by habit.
    if (item.groups.some((g) => g.required)) {
      const last = pruneSelection(item.groups, cart.lastChoice(item.id) ?? []);
      if (last.length > 0 && checkSelection(entities, item.id, last, cartState.channel).ok) {
        cart.addItem({ itemId: item.id, optionIds: last });
        return;
      }
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

  const title = tr(platform ? 'platform.title' : 'pos.orderEntry.title');
  const searchField = (
    <label
      className="g-field g-glass"
      style={s('width:230px;height:48px;border-radius:999px;background:var(--glass)')}
    >
      <Gi n="search" />
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        aria-label={tr('common.search')}
        placeholder={tr('pos.orderEntry.searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </label>
  );
  const phoneSearchField = (
    <label
      className="g-field g-glass"
      style={s('height:48px;border-radius:999px;background:var(--glass)')}
    >
      <Gi n="search" />
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: the person just tapped the search button
        autoFocus
        aria-label={tr('common.search')}
        placeholder={tr('pos.orderEntry.searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </label>
  );
  const subtitle = [
    weekdayDate(now, locale),
    hours ? tr('pos.orderEntry.hoursLine', { hours }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      style={s(
        `flex:1;min-height:0;display:flex;gap:18px;position:relative;${phone ? 'flex-direction:column;gap:0;' : ''}`,
      )}
    >
      <section
        aria-label={title}
        style={s(
          `flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:${phone ? 14 : 16}px;${
            phone ? 'padding:calc(env(safe-area-inset-top, 0px) + 16px) 20px 0;' : ''
          }`,
        )}
      >
        <CatalogueNotice />
        {phone ? (
          <div style={s('display:flex;align-items:center;gap:12px')}>
            <div style={s('flex-grow:1;min-width:0')}>
              <h1 className="g-t-1" style={s('margin:0')}>
                {tr(platform ? 'platform.title' : 'nav.new')}
              </h1>
              <div className="g-t-c">
                {tr('pos.orderEntry.phoneSub', {
                  channel: tr(`orders.channel.${platform ? cartState.channel : 'storefront'}`),
                })}
              </div>
            </div>
            <button
              type="button"
              className="g-btn g-btn-icon g-glass"
              aria-label={tr('common.search')}
              aria-expanded={searching}
              style={s('background:var(--glass)')}
              onClick={() => setSearching((v) => !v)}
            >
              <Gi n="search" />
            </button>
            <SyncPill compact />
          </div>
        ) : (
          <PageHeader title={title} subtitle={subtitle}>
            {searchField}
            <SyncPill />
            <OutboxPill />
          </PageHeader>
        )}
        {phone && searching ? phoneSearchField : null}
        {phone ? <OutboxPill /> : null}

        {totalDishes > 0 ? (
          <nav
            aria-label={tr('pos.orderEntry.categories')}
            className="g-scroll"
            style={s(
              phone
                ? 'display:flex;gap:8px;margin:0 -20px;padding:0 20px;flex:none'
                : 'display:flex;gap:10px;flex:none;flex-wrap:wrap',
            )}
          >
            <button
              type="button"
              className={`g-chip${activeCategory === 'all' ? ' g-on' : ''}`}
              aria-pressed={activeCategory === 'all'}
              onClick={() => setCategory('all')}
            >
              {tr('pos.orderEntry.all')}
            </button>
            {menu.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`g-chip${activeCategory === c.id ? ' g-on' : ''}`}
                aria-pressed={activeCategory === c.id}
                onClick={() => setCategory(c.id)}
              >
                {localName(locale, c.nameTh, c.nameEn)}
              </button>
            ))}
          </nav>
        ) : null}

        <div
          className="g-scroll"
          style={s(
            phone
              ? 'flex-grow:1;min-height:0;margin:0 -20px;padding:2px 20px 190px'
              : 'flex-grow:1;min-height:0;margin:-4px -6px;padding:4px 6px 40px',
          )}
        >
          {emptyMenuKey ? (
            <p className="g-t-s" role="status">
              {tr(emptyMenuKey)}
            </p>
          ) : shown.length === 0 ? (
            <p className="g-t-s" role="status">
              {tr('pos.orderEntry.noMatch')}
            </p>
          ) : (
            <ul
              style={s(
                `list-style:none;margin:0;padding:0;display:grid;gap:14px;grid-template-columns:${
                  phone ? 'repeat(2,minmax(0,1fr))' : 'repeat(auto-fill,minmax(190px,1fr))'
                }`,
              )}
            >
              {shown.map((item) => {
                const count = inCart.get(item.id);
                const art = dishArt(item.nameTh, item.nameEn);
                return (
                  <li key={item.id} style={s('display:flex')}>
                    <button
                      type="button"
                      className={`g-tile g-glass g-rise${item.soldOut ? ' g-out' : ''}`}
                      style={s('width:100%')}
                      disabled={item.soldOut || locked}
                      onClick={() => pick(item)}
                    >
                      <span
                        className={`g-ph g-tg-${art.tint}`}
                        aria-hidden="true"
                        style={s(`height:${phone ? 96 : 108}px`)}
                      >
                        <img
                          className={item.imageUrl ? 'g-photo' : undefined}
                          src={item.imageUrl ?? dishArtUrl(art)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                        />
                      </span>
                      <span
                        className="g-t-3 g-clamp2"
                        style={s(
                          'font-size:15px;line-height:1.5;min-height:45px;padding:0 4px;display:-webkit-box',
                        )}
                      >
                        {localName(locale, item.nameTh, item.nameEn)}
                      </span>
                      <span
                        style={s(
                          'display:flex;align-items:center;justify-content:space-between;padding:0 4px',
                        )}
                      >
                        <span className="g-num g-t-2">
                          {formatBaht(item.priceSatang, locale, { decimals: 'auto' })}
                        </span>
                        {item.soldOut ? (
                          <span className="g-badge g-b-bad">
                            <Gi n="x" />
                            {tr('pos.orderEntry.soldOut')}
                          </span>
                        ) : (
                          <span className="g-add" aria-hidden="true">
                            <Gi n="plus" size="sm" />
                          </span>
                        )}
                      </span>
                      {count ? (
                        <span
                          className="g-badge g-pop"
                          style={s(
                            `position:absolute;top:${phone ? 16 : 18}px;right:${phone ? 16 : 18}px;background:var(--ink);color:#fff;height:${phone ? 28 : 30}px;padding:0 12px;font-size:14px`,
                          )}
                        >
                          <span aria-hidden="true">×{count}</span>
                          <span className="visually-hidden">
                            {tr('pos.orderEntry.inCart', { count })}
                          </span>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {phone ? (
          <div
            className="g-fade-b"
            aria-hidden="true"
            style={s('position:absolute;left:0;right:0;bottom:0;height:150px;pointer-events:none')}
          />
        ) : null}
      </section>

      {phone ? null : (
        <aside
          className="g-glass2"
          data-testid="cart"
          style={s(
            'width:372px;flex:none;display:flex;flex-direction:column;border-radius:32px;padding:22px 20px 20px;min-height:0',
          )}
        >
          <CartPanel onEditLine={editLine} mode={mode} />
        </aside>
      )}

      {phone && cartState.lines.length > 0 ? (
        <button
          type="button"
          data-testid="cart-bar"
          className="g-glass2 g-slide-up"
          onClick={() => setCartOpen(true)}
          style={s(
            'position:fixed;left:16px;right:16px;bottom:108px;height:68px;border-radius:34px;display:flex;align-items:center;gap:12px;padding:0 10px 0 18px;text-align:left;font:inherit;color:inherit;cursor:pointer;z-index:4;--d:.2s',
          )}
        >
          <span
            style={s(
              'position:relative;width:40px;height:40px;border-radius:50%;background:rgba(198,40,40,.12);color:var(--chili);display:grid;place-items:center;flex:none',
            )}
          >
            <Gi n="bag" />
          </span>
          <span style={s('flex-grow:1;line-height:1.3;display:block')}>
            <span className="g-t-c" style={s('display:block')}>
              {tr('pos.orderEntry.viewOrder', { count: pricing.itemCount })}
            </span>
            <span className="g-num g-t-2" style={s('display:block')}>
              {formatBaht(pricing.totalSatang, locale)}
            </span>
          </span>
          <span className="g-btn g-btn-p" style={s('height:48px')}>
            {tr('pos.orderEntry.chargeShort')}
            <Gi n="chevronRight" size="sm" />
          </span>
        </button>
      ) : null}

      {phone && cartOpen ? (
        <Modal labelledBy="cart-title" onClose={() => setCartOpen(false)} variant="cart">
          <div style={s('padding:22px 20px 24px;display:flex;flex-direction:column;min-height:0')}>
            <CartPanel onClose={() => setCartOpen(false)} onEditLine={editLine} mode={mode} />
          </div>
        </Modal>
      ) : null}

      {sheet && sheetItem ? (
        <ModifierSheet target={sheet} item={sheetItem} onClose={closeSheet} mode={mode} />
      ) : null}
    </div>
  );
}
