import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useEntities, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { deliveryBuildings, recipientChips } from './delivery-model.ts';

/**
 * Where the order goes (every order is an entrance delivery, owner 2026-10-02): the building, the
 * recipient's name and other details, with the remembered recipients as chips that prefill all
 * three. Everything stays editable; the customer id only travels while building and name are as
 * the chip had them (the cart store decides that).
 *
 * The name field and the chips show personal data: nothing is logged or put in the address.
 */
export function DeliveryFields({ locked }: { locked: boolean }) {
  const { cart, recipients } = useServices();
  const state = useStoreState(cart);
  const remembered = useStoreState(recipients);
  const entities = useEntities();
  const tr = useT();

  const buildings = deliveryBuildings(entities.settings);
  const typed = state.recipientName.trim() !== '' && remembered.matches !== null;
  const chips = recipientChips(typed ? (remembered.matches ?? []) : remembered.recent);

  const fieldStyle = s('height:46px;border-radius:14px;font-size:14px');

  return (
    <section
      className="g-sunk"
      aria-label={tr('pos.delivery.title')}
      style={s('padding:14px 16px;display:flex;flex-direction:column;gap:12px')}
    >
      <div style={s('display:flex;flex-direction:column;gap:2px')}>
        <h3 className="g-t-3" style={s('margin:0;font-size:15px')}>
          {tr('pos.delivery.title')}
        </h3>
        <p className="g-t-c" style={s('margin:0')}>
          {tr('pos.delivery.hint')}
        </p>
      </div>

      {chips.length > 0 ? (
        <div style={s('display:flex;flex-direction:column;gap:6px')}>
          <span className="g-t-c">
            {tr(typed ? 'pos.delivery.matches' : 'pos.delivery.recent')}
          </span>
          <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
            {chips.map(({ recipient, label, hint }) => (
              <button
                key={recipient.id}
                type="button"
                className="g-chip rchip"
                style={s('height:36px;padding:0 14px;font-size:14px')}
                disabled={locked}
                aria-label={hint ? `${label} ${hint}` : label}
                onClick={() => {
                  cart.chooseRecipient(recipient);
                  recipients.search('');
                }}
              >
                {label}
                {hint ? (
                  <span className="g-t-c" style={s('margin-left:6px')}>
                    {hint}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {buildings === null && !remembered.buildingsFailed ? (
        <p className="g-t-s" role="status" style={s('margin:0')}>
          {tr('pos.delivery.buildingLoading')}
        </p>
      ) : buildings === null ? (
        <div role="status" style={s('display:flex;align-items:center;gap:10px')}>
          <span className="g-t-s" style={s('flex-grow:1')}>
            {tr('pos.delivery.buildingMissing')}
          </span>
          <button
            type="button"
            className="g-btn g-btn-sm"
            onClick={() => void recipients.ensureBuildings()}
          >
            {tr('common.retry')}
          </button>
        </div>
      ) : (
        <fieldset
          style={s(
            'border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:6px',
          )}
        >
          <legend className="g-t-c" style={s('padding:0;margin-bottom:6px')}>
            {tr('pos.delivery.building')}
          </legend>
          <div style={s('display:flex;flex-wrap:wrap;gap:8px')}>
            {buildings.map((name) => (
              <label
                key={name}
                className={`g-chip${state.deliveryBuilding === name ? ' g-on' : ''}`}
                style={s(
                  `height:44px;padding:0 16px;font-size:14px;${locked ? 'opacity:.6;' : ''}`,
                )}
              >
                <input
                  type="radio"
                  name="delivery-building"
                  value={name}
                  checked={state.deliveryBuilding === name}
                  disabled={locked}
                  onChange={() => cart.setBuilding(name)}
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div style={s('display:flex;flex-direction:column;gap:6px')}>
        <label className="g-t-c" htmlFor="recipient-name">
          {tr('pos.delivery.name')}
        </label>
        <div className="g-field" style={fieldStyle}>
          <Gi n="user" size="sm" />
          <input
            id="recipient-name"
            type="text"
            autoComplete="off"
            autoCapitalize="words"
            maxLength={60}
            placeholder={tr('pos.delivery.namePlaceholder')}
            disabled={locked}
            value={state.recipientName}
            onChange={(event) => {
              cart.setRecipientName(event.target.value);
              recipients.search(event.target.value);
            }}
          />
        </div>
      </div>

      <div style={s('display:flex;flex-direction:column;gap:6px')}>
        <label className="g-t-c" htmlFor="recipient-note">
          {tr('pos.delivery.note')}
        </label>
        <div className="g-field" style={fieldStyle}>
          <Gi n="note" size="sm" />
          <input
            id="recipient-note"
            type="text"
            autoComplete="off"
            maxLength={200}
            placeholder={tr('pos.delivery.notePlaceholder')}
            disabled={locked}
            value={state.deliveryNote}
            onChange={(event) => cart.setDeliveryNote(event.target.value)}
          />
        </div>
        <p className="g-t-c" style={s('margin:0')}>
          {tr('pos.delivery.noteHint')}
        </p>
      </div>
    </section>
  );
}
