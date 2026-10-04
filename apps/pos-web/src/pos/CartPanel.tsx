import { formatBaht } from '@sds/i18n';
import { useContext, useMemo, useState } from 'react';
import { codeText, errorText } from '../api/errors.ts';
import { goTo } from '../app/navigate.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import {
  AuthContext,
  useEntities,
  useLocale,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';
import { priceCart } from './cart-pricing.ts';
import type { CartMode } from './cart-store.ts';
import { DeliveryFields } from './DeliveryFields.tsx';
import { deliveryBuildings, deliveryReady } from './delivery-model.ts';
import { dishArt, dishArtUrl } from './dish-art.ts';
import { localName } from './names.ts';
import { saveErrorText } from './outbox-text.ts';
import { PlatformFields } from './PlatformFields.tsx';
import {
  PLATFORM_CHANNELS,
  PLATFORM_NOTE_MAX,
  type PlatformChannel,
  platformRefSchema,
} from './platform-model.ts';
import { useCart } from './use-cart.ts';

/**
 * The order on the counter: where it goes, the lines, a note to the kitchen, the ESTIMATED total
 * and the create button. The estimate is labelled as one; the server's total is shown on the order page
 * after the order is created. A panel beside the menu on iPad and laptop, a sheet on iPhone.
 *
 * `mode` platform: an order keyed in by hand from Grab or LINE MAN. It has no recipient; it has the
 * platform's order code instead, and the platform's prices.
 *
 * Offline, the same button saves the order on this device (the outbox) and says so; the order page
 * then shows it as waiting to sync.
 */
export function CartPanel({
  onClose,
  onEditLine,
  mode = 'storefront',
}: {
  onClose?: () => void;
  onEditLine: (lineKey: string) => void;
  mode?: CartMode;
}) {
  const { recipients, outbox } = useServices();
  const cart = useCart(mode);
  const offline = useStoreState(outbox).offline;
  const platform = mode === 'platform';
  const state = useStoreState(cart);
  const entities = useEntities();
  const tr = useT();
  const locale = useLocale();
  // Read once: the session cannot change under an open cart (signing out unmounts it).
  const staff = useContext(AuthContext)?.getState().session?.staff;

  const pricing = useMemo(
    () => priceCart(entities, state.lines, state.channel),
    [entities, state.lines, state.channel],
  );
  const priced = new Map(pricing.lines.map((l) => [l.key, l]));
  const locked = state.phase !== 'editing';
  const sending = state.phase === 'sending';
  const unsure = state.phase === 'unsure';
  const buildings = deliveryBuildings(entities.settings);
  const detailsOk = platform
    ? platformRefSchema.safeParse(state.platformRef).success
    : deliveryReady({ building: state.deliveryBuilding, name: state.recipientName }, buildings);
  // An order we are unsure about is retried as it was sent, whatever the menu says now.
  const canPlace = state.lines.length > 0 && !sending && (unsure || (pricing.valid && detailsOk));
  const [confirmingClear, setConfirmingClear] = useState(false);

  async function place() {
    const outcome = await cart.submit();
    if (!outcome.ok) return;
    if (!platform) {
      // The newest recipient is now first in the list for the next order.
      void recipients.refresh();
    }
    onClose?.();
    // A waiting order has its own page until the server numbers it.
    goTo(`/orders/${'queued' in outcome ? outcome.queued.id : outcome.order.id}`);
  }

  const empty = state.lines.length === 0;
  const chargeLabel = tr(
    sending
      ? 'pos.orderEntry.placing'
      : unsure
        ? 'common.retry'
        : offline
          ? 'pos.orderEntry.placeOffline'
          : platform
            ? 'platform.place'
            : 'pos.orderEntry.charge',
    { amount: formatBaht(pricing.totalSatang, locale) },
  );

  return (
    <section
      aria-label={tr(platform ? 'platform.title' : 'pos.orderEntry.newOrder')}
      style={s(
        onClose
          ? 'display:flex;flex-direction:column;gap:14px'
          : 'flex:1;min-height:0;display:flex;flex-direction:column;gap:14px',
      )}
    >
      <header style={s('display:flex;align-items:center;gap:12px')}>
        <div style={s('flex-grow:1;min-width:0')}>
          <h2 id="cart-title" className="g-t-2" style={s('margin:0')}>
            {tr(platform ? 'platform.title' : 'pos.orderEntry.newOrder')}
          </h2>
          {staff ? (
            <div className="g-t-c">{`${staff.displayName} · ${tr(`role.${staff.role}`)}`}</div>
          ) : null}
        </div>
        <span className="g-badge g-b-warn">
          <Gi n="pending" />
          {tr('status.payment.unpaid')}
        </span>
        {onClose ? (
          <button
            type="button"
            className="g-btn g-btn-icon"
            aria-label={tr('pos.orderEntry.closeOrder')}
            onClick={onClose}
          >
            <Gi n="x" />
          </button>
        ) : null}
      </header>

      <fieldset
        className="g-seg"
        style={s('width:100%;border:0;margin:0')}
        aria-label={tr('orders.channel')}
      >
        <button
          type="button"
          className={`g-chip${platform ? '' : ' g-on'}`}
          style={s('flex:1')}
          aria-pressed={!platform}
          onClick={() => (platform ? goTo('/new') : undefined)}
        >
          {tr('orders.channel.storefront')}
        </button>
        <button
          type="button"
          className="g-chip"
          style={s('flex:1;opacity:.5;cursor:not-allowed')}
          disabled
          title={tr('nav.notReady')}
        >
          {tr('orders.channel.line')}
        </button>
        <button
          type="button"
          className={`g-chip${platform ? ' g-on' : ''}`}
          style={s('flex:1')}
          aria-pressed={platform}
          onClick={() => (platform ? undefined : goTo('/platform'))}
        >
          {tr('orders.channel.grab')}
        </button>
      </fieldset>

      <div
        className={onClose ? undefined : 'g-scroll'}
        // in the phone sheet the whole sheet scrolls (the keyboard leaves no room for a second scroller)
        style={s(
          onClose
            ? 'display:flex;flex-direction:column;gap:12px'
            : 'flex-grow:1;min-height:0;display:flex;flex-direction:column;gap:12px',
        )}
      >
        {platform ? (
          <fieldset style={s('border:0;margin:0;padding:0;min-width:0')}>
            <legend className="visually-hidden">{tr('platform.channel')}</legend>
            <div className="g-seg" style={s('width:100%')}>
              {PLATFORM_CHANNELS.map((channel: PlatformChannel) => (
                <label
                  key={channel}
                  className={`g-chip${state.channel === channel ? ' g-on' : ''}`}
                  style={s(`flex:1;${locked ? 'opacity:.6;' : ''}`)}
                >
                  <input
                    type="radio"
                    name="platform-channel"
                    checked={state.channel === channel}
                    disabled={locked}
                    onChange={() => cart.setChannel(channel)}
                  />
                  {tr(`orders.channel.${channel}`)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {empty ? (
          <div
            style={s(
              'flex-grow:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:20px',
            )}
          >
            <div
              className="g-ico"
              style={s(
                'width:64px;height:64px;border-radius:22px;background:var(--glass2);color:var(--chili);box-shadow:var(--sh1)',
              )}
            >
              <Gi n="bag" size="lg" />
            </div>
            <div className="g-t-3">{tr('pos.orderEntry.emptyTitle')}</div>
            <div className="g-t-s">{tr('pos.orderEntry.emptyCart')}</div>
          </div>
        ) : (
          <ul
            style={s(
              'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px',
            )}
          >
            {state.lines.map((line) => {
              const item = entities.items.get(line.itemId);
              const name = item ? localName(locale, item.nameTh, item.nameEn) : '';
              const result = priced.get(line.key);
              const art = item ? dishArt(item.nameTh, item.nameEn) : null;
              const chosen = line.optionIds.flatMap((id) => {
                const option = entities.options.get(id);
                return option ? [option] : [];
              });
              const mods = chosen
                .map((o) => {
                  const label = localName(locale, o.nameTh, o.nameEn);
                  return o.priceDeltaSatang > 0
                    ? `${label} ${tr('pos.modifier.priceUp', { amount: formatBaht(o.priceDeltaSatang, locale, { decimals: 'auto' }) })}`
                    : label;
                })
                .join(' · ');
              return (
                <li
                  key={line.key}
                  style={s('display:flex;gap:12px;align-items:center')}
                  aria-invalid={result?.ok === false ? true : undefined}
                >
                  <button
                    type="button"
                    disabled={locked}
                    aria-label={tr('pos.orderEntry.editLine', { name })}
                    onClick={() => onEditLine(line.key)}
                    style={s(
                      'all:unset;box-sizing:border-box;display:flex;gap:12px;align-items:center;flex-grow:1;min-width:0;cursor:pointer;border-radius:18px',
                    )}
                  >
                    {item && art ? (
                      <span
                        className={`g-tg-${art.tint}`}
                        aria-hidden="true"
                        style={s(
                          'width:56px;height:56px;border-radius:18px;flex:none;display:grid;place-items:center;background:linear-gradient(160deg,var(--g1),var(--g2));overflow:hidden',
                        )}
                      >
                        <img
                          src={item.imageUrl ?? dishArtUrl(art)}
                          alt=""
                          draggable={false}
                          style={s(
                            item.imageUrl
                              ? 'width:100%;height:100%;object-fit:cover'
                              : 'width:42px;height:auto',
                          )}
                        />
                      </span>
                    ) : null}
                    <span style={s('flex-grow:1;min-width:0;display:block')}>
                      <span
                        className="g-t-3 g-clamp2"
                        style={s('font-size:15px;display:-webkit-box')}
                      >
                        {name}
                      </span>
                      {mods ? (
                        <span className="g-t-c" style={s('display:block')}>
                          {mods}
                        </span>
                      ) : null}
                      {line.note ? (
                        <span
                          className="g-t-c"
                          style={s(
                            'display:flex;align-items:center;gap:4px;color:var(--amber-ink)',
                          )}
                        >
                          <Gi n="note" size="sm" />
                          {line.note}
                        </span>
                      ) : null}
                      {result?.ok === false ? (
                        <span
                          className="g-t-c"
                          role="status"
                          style={s(
                            'display:flex;align-items:center;gap:4px;color:var(--chili-ink)',
                          )}
                        >
                          <Gi n="warn" size="sm" />
                          <span>{tr('pos.orderEntry.lineProblem')}</span>
                          {result.errors[0] ? (
                            <span>{codeText(tr, result.errors[0].code)}</span>
                          ) : null}
                        </span>
                      ) : null}
                      <span
                        className="g-num g-t-3"
                        style={s('font-size:15px;padding-top:2px;display:block')}
                      >
                        {result?.ok && result.lineTotalSatang !== undefined
                          ? formatBaht(result.lineTotalSatang, locale, { decimals: 'auto' })
                          : ''}
                      </span>
                    </span>
                  </button>
                  <div className="g-step">
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={tr('pos.orderEntry.decrease', { name })}
                      onClick={() => cart.setQty(line.key, line.qty - 1)}
                    >
                      <Gi n="minus" size="sm" />
                    </button>
                    <b>{line.qty}</b>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={tr('pos.orderEntry.increase', { name })}
                      onClick={() => cart.setQty(line.key, line.qty + 1)}
                    >
                      <Gi n="plus" size="sm" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {platform ? <PlatformFields locked={locked} /> : <DeliveryFields locked={locked} />}
      </div>

      <div style={s('flex:none;display:flex;flex-direction:column;gap:8px')}>
        <label className="visually-hidden" htmlFor="order-note">
          {tr('pos.orderEntry.orderNote')}
        </label>
        <div className="g-field" style={s('height:46px;border-radius:14px;font-size:14px')}>
          <Gi n="note" size="sm" />
          <input
            id="order-note"
            type="text"
            maxLength={platform ? PLATFORM_NOTE_MAX : 500}
            autoComplete="off"
            placeholder={tr('pos.orderEntry.orderNotePlaceholder')}
            disabled={locked}
            value={state.note}
            onChange={(event) => cart.setNote(event.target.value)}
          />
        </div>

        {state.phase === 'unsure' ? (
          <p
            className="g-badge g-b-bad"
            role="alert"
            style={s('height:auto;padding:8px 12px;white-space:normal;margin:0')}
          >
            <Gi n="warn" />
            {tr('pos.orderEntry.unsure')}
          </p>
        ) : state.error ? (
          <p
            className="g-badge g-b-bad"
            role="alert"
            style={s('height:auto;padding:8px 12px;white-space:normal;margin:0')}
          >
            <Gi n="warn" />
            {errorText(tr, state.error)}
          </p>
        ) : null}

        {state.saveError ? (
          <p
            className="g-badge g-b-bad"
            role="alert"
            style={s('height:auto;padding:8px 12px;white-space:normal;margin:0')}
          >
            <Gi n="warn" />
            {saveErrorText(tr, state.saveError)}
          </p>
        ) : offline && !sending ? (
          <p
            className="g-badge g-b-warn"
            role="status"
            style={s('height:auto;padding:8px 12px;white-space:normal;margin:0')}
          >
            <Gi n="warn2" />
            <span>{tr('pos.orderEntry.offlineHint')}</span>
          </p>
        ) : null}

        {state.lines.length > 0 && !unsure && !detailsOk ? (
          <p className="g-t-c" style={s('margin:0')}>
            {tr(platform ? 'platform.refNeeded' : 'pos.delivery.needed')}
          </p>
        ) : null}
      </div>

      <div
        className="g-sunk"
        style={s('flex:none;padding:14px 16px;display:flex;flex-direction:column;gap:4px')}
      >
        <div
          className="g-t-s"
          style={s('display:flex;justify-content:space-between;align-items:center')}
        >
          <span>
            {tr('pos.orderEntry.itemsCount', { count: pricing.itemCount })}
            {empty ? null : (
              <>
                {' · '}
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => (unsure ? setConfirmingClear(true) : cart.clear())}
                  style={s(
                    'all:unset;cursor:pointer;color:var(--chili);font-weight:600;text-decoration:underline;text-underline-offset:3px',
                  )}
                >
                  {tr('pos.orderEntry.clear')}
                </button>
              </>
            )}
          </span>
          <span className="g-num">{formatBaht(pricing.totalSatang, locale)}</span>
        </div>
        <div style={s('display:flex;justify-content:space-between;align-items:baseline')}>
          <span className="g-t-3">{tr('pos.orderEntry.estimate')}</span>
          <span className="g-num" style={s('font-size:36px;line-height:1.3;font-weight:600')}>
            {formatBaht(pricing.totalSatang, locale)}
          </span>
        </div>
        <div className="g-t-c">{tr('pos.orderEntry.estimateHint')}</div>
      </div>
      <button
        type="button"
        className="g-btn g-btn-p g-btn-lg g-btn-block"
        style={s('flex:none')}
        disabled={!canPlace}
        aria-busy={sending}
        onClick={() => void place()}
      >
        {chargeLabel}
        <Gi n="chevronRight" />
      </button>

      {confirmingClear && unsure ? (
        <PortalModal labelledBy="clear-unsure-title" onClose={() => setConfirmingClear(false)}>
          <h2 id="clear-unsure-title" className="g-t-2" style={s('margin:0')}>
            {tr('pos.orderEntry.clearUnsure.title')}
          </h2>
          <p className="g-t-s" style={s('margin:0')}>
            {tr('pos.orderEntry.clearUnsure.body')}
          </p>
          <a className="g-btn g-btn-p g-btn-block" href="#/orders">
            {tr('pos.orderEntry.clearUnsure.check')}
          </a>
          <button
            type="button"
            className="g-btn g-btn-block"
            onClick={() => setConfirmingClear(false)}
          >
            {tr('pos.orderEntry.clearUnsure.keep')}
          </button>
          <button
            type="button"
            className="g-btn g-btn-block"
            onClick={() => {
              setConfirmingClear(false);
              cart.clear();
            }}
          >
            {tr('pos.orderEntry.clearUnsure.discard')}
          </button>
        </PortalModal>
      ) : null}
    </section>
  );
}
