import { formatBaht } from '@sds/i18n';
import { useMemo } from 'react';
import { codeText, errorText } from '../api/errors.ts';
import { goTo } from '../app/navigate.ts';
import { useEntities, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { priceCart } from './cart-pricing.ts';
import type { CounterFulfillment } from './cart-store.ts';
import { localName } from './names.ts';

const FULFILLMENTS: readonly CounterFulfillment[] = ['dine_in', 'takeaway', 'room_delivery'];

/**
 * The order on the counter: how it is served, the lines, a note, the ESTIMATED total and the
 * create button. The estimate is labelled as one; the server's total is shown on the order page
 * after the order is created. A panel beside the menu on iPad and laptop, a sheet on iPhone.
 */
export function CartPanel({
  onClose,
  onEditLine,
}: {
  onClose?: () => void;
  onEditLine: (lineKey: string) => void;
}) {
  const { cart } = useServices();
  const state = useStoreState(cart);
  const entities = useEntities();
  const tr = useT();
  const locale = useLocale();

  const pricing = useMemo(() => priceCart(entities, state.lines), [entities, state.lines]);
  const priced = new Map(pricing.lines.map((l) => [l.key, l]));
  const locked = state.phase !== 'editing';
  const sending = state.phase === 'sending';
  const needsRoom = state.fulfillment === 'room_delivery' && state.roomNo.trim() === '';
  const canPlace = state.lines.length > 0 && !sending && pricing.valid && !needsRoom;

  async function place() {
    const outcome = await cart.submit();
    if (outcome.ok) {
      onClose?.();
      goTo(`/orders/${outcome.order.id}`);
    }
  }

  return (
    <section className="cart" aria-label={tr('pos.orderEntry.newOrder')}>
      <header className="cart__head">
        <div className="cart__title-row">
          <h2 id="cart-title" className="cart__title">
            {tr('pos.orderEntry.newOrder')}
          </h2>
          {onClose ? (
            <button
              type="button"
              className="btn btn-soft"
              aria-label={tr('pos.orderEntry.closeOrder')}
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </div>
        <fieldset className="seg">
          <legend className="visually-hidden">{tr('pos.orderEntry.fulfilment.label')}</legend>
          {FULFILLMENTS.map((value) => (
            <label
              key={value}
              className={`seg__item${state.fulfillment === value ? ' seg__item--on' : ''}${locked ? ' seg__item--locked' : ''}`}
            >
              <input
                className="visually-hidden"
                type="radio"
                name="fulfilment"
                checked={state.fulfillment === value}
                disabled={locked}
                onChange={() => cart.setFulfillment(value)}
              />
              {tr(`pos.orderEntry.fulfilment.${value}`)}
            </label>
          ))}
        </fieldset>
        {state.fulfillment === 'room_delivery' ? (
          <div className="field-group">
            <label className="label" htmlFor="order-room">
              {tr('pos.orderEntry.roomNo')}
            </label>
            <input
              id="order-room"
              className="input"
              type="text"
              inputMode="text"
              autoComplete="off"
              maxLength={20}
              placeholder={tr('pos.orderEntry.roomNoPlaceholder')}
              disabled={locked}
              value={state.roomNo}
              onChange={(event) => cart.setRoomNo(event.target.value)}
            />
          </div>
        ) : null}
      </header>

      {state.lines.length === 0 ? (
        <div className="cart__empty empty">
          <Icon name="cart" />
          <p>{tr('pos.orderEntry.emptyCart')}</p>
        </div>
      ) : (
        <ul className="cart__lines">
          {state.lines.map((line) => {
            const item = entities.items.get(line.itemId);
            const name = item ? localName(locale, item.nameTh, item.nameEn) : '';
            const result = priced.get(line.key);
            const chosen = line.optionIds.flatMap((id) => {
              const option = entities.options.get(id);
              return option ? [option] : [];
            });
            return (
              <li key={line.key} className={result?.ok === false ? 'line line--bad' : 'line'}>
                <button
                  type="button"
                  className="line__main"
                  disabled={locked}
                  aria-label={tr('pos.orderEntry.editLine', { name })}
                  onClick={() => onEditLine(line.key)}
                >
                  <span className="line__name">{name}</span>
                  {chosen.length > 0 ? (
                    <span className="line__mods">
                      {chosen
                        .map((o) => {
                          const label = localName(locale, o.nameTh, o.nameEn);
                          return o.priceDeltaSatang > 0
                            ? `${label} ${tr('pos.modifier.priceUp', { amount: formatBaht(o.priceDeltaSatang, locale, { decimals: 'auto' }) })}`
                            : label;
                        })
                        .join(' · ')}
                    </span>
                  ) : null}
                  {line.note ? (
                    <span className="line__note">
                      <Icon name="note" />
                      {line.note}
                    </span>
                  ) : null}
                  {result?.ok === false ? (
                    <span className="line__problem" role="status">
                      <Icon name="alert" />
                      <span>{tr('pos.orderEntry.lineProblem')}</span>
                      {result.errors[0] ? <span>{codeText(tr, result.errors[0].code)}</span> : null}
                    </span>
                  ) : null}
                </button>
                <div className="line__side">
                  <span className="line__amt money">
                    {result?.ok && result.lineTotalSatang !== undefined
                      ? formatBaht(result.lineTotalSatang, locale)
                      : ''}
                  </span>
                  <div className="stepper">
                    <button
                      type="button"
                      className="btn"
                      disabled={locked}
                      aria-label={tr('pos.orderEntry.decrease', { name })}
                      onClick={() => cart.setQty(line.key, line.qty - 1)}
                    >
                      <Icon name="minus" />
                    </button>
                    <span className="qty">{line.qty}</span>
                    <button
                      type="button"
                      className="btn"
                      disabled={locked}
                      aria-label={tr('pos.orderEntry.increase', { name })}
                      onClick={() => cart.setQty(line.key, line.qty + 1)}
                    >
                      <Icon name="plus" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="cart__foot">
        <div className="field-group">
          <label className="label" htmlFor="order-note">
            {tr('pos.orderEntry.orderNote')}
          </label>
          <input
            id="order-note"
            className="input"
            type="text"
            maxLength={500}
            autoComplete="off"
            placeholder={tr('pos.orderEntry.orderNotePlaceholder')}
            disabled={locked}
            value={state.note}
            onChange={(event) => cart.setNote(event.target.value)}
          />
        </div>

        {state.phase === 'unsure' ? (
          <p className="error" role="alert">
            {tr('pos.orderEntry.unsure')}
          </p>
        ) : state.error ? (
          <p className="error" role="alert">
            {errorText(tr, state.error)}
          </p>
        ) : null}

        <div className="sumrow muted small">
          <span>{tr('pos.orderEntry.itemsCount', { count: pricing.itemCount })}</span>
        </div>
        <div className="sumrow total">
          <span>{tr('pos.orderEntry.estimate')}</span>
          <span className="money">{formatBaht(pricing.totalSatang, locale)}</span>
        </div>
        <p className="hint">{tr('pos.orderEntry.estimateHint')}</p>
        <div className="cart__actions">
          <button
            type="button"
            className="btn btn-soft"
            disabled={state.lines.length === 0 || sending}
            onClick={() => cart.clear()}
          >
            {tr('pos.orderEntry.clear')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-lg cart__place"
            disabled={!canPlace}
            aria-busy={sending}
            onClick={() => void place()}
          >
            {tr(sending ? 'pos.orderEntry.placing' : 'pos.orderEntry.place')}
          </button>
        </div>
      </footer>
    </section>
  );
}
