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

  return (
    <section className="deliv" aria-label={tr('pos.delivery.title')}>
      <div className="deliv__head">
        <h3 className="deliv__title">{tr('pos.delivery.title')}</h3>
        <p className="hint">{tr('pos.delivery.hint')}</p>
      </div>

      {chips.length > 0 ? (
        <div className="deliv__recent">
          <span className="label">
            {tr(typed ? 'pos.delivery.matches' : 'pos.delivery.recent')}
          </span>
          <div className="chips">
            {chips.map(({ recipient, label, hint }) => (
              <button
                key={recipient.id}
                type="button"
                className="rchip"
                disabled={locked}
                aria-label={hint ? `${label} ${hint}` : label}
                onClick={() => {
                  cart.chooseRecipient(recipient);
                  recipients.search('');
                }}
              >
                <span className="rchip__name">{label}</span>
                {hint ? <span className="rchip__hint">{hint}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {buildings === null ? (
        <div className="deliv__missing" role="status">
          <span className="muted">{tr('pos.delivery.buildingMissing')}</span>
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => void recipients.ensureBuildings()}
          >
            {tr('common.retry')}
          </button>
        </div>
      ) : (
        <fieldset className="bld">
          <legend className="label">{tr('pos.delivery.building')}</legend>
          {buildings.map((name) => (
            <label
              key={name}
              className={`bld__item${state.deliveryBuilding === name ? ' bld__item--on' : ''}${locked ? ' seg__item--locked' : ''}`}
            >
              <input
                className="visually-hidden"
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
        </fieldset>
      )}

      <div className="field-group">
        <label className="label" htmlFor="recipient-name">
          {tr('pos.delivery.name')}
        </label>
        <input
          id="recipient-name"
          className="input"
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

      <div className="field-group">
        <label className="label" htmlFor="recipient-note">
          {tr('pos.delivery.note')}
        </label>
        <input
          id="recipient-note"
          className="input"
          type="text"
          autoComplete="off"
          maxLength={200}
          placeholder={tr('pos.delivery.notePlaceholder')}
          disabled={locked}
          value={state.deliveryNote}
          onChange={(event) => cart.setDeliveryNote(event.target.value)}
        />
        <p className="hint">{tr('pos.delivery.noteHint')}</p>
      </div>
    </section>
  );
}
