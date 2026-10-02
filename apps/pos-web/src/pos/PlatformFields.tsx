import { useEntities, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import {
  duplicatePlatformRef,
  isPlatformChannel,
  PLATFORM_REF_MAX,
  platformRefSchema,
} from './platform-model.ts';
import { useCart } from './use-cart.ts';

/**
 * What a Grab or LINE MAN order has in place of a recipient: the platform's own order code, which
 * the person handing the bag to the rider will look for. It is required, and a code that was
 * already keyed in (an order, or one waiting to sync) is called out before it is keyed twice.
 */
export function PlatformFields({ locked }: { locked: boolean }) {
  const { outbox } = useServices();
  const cart = useCart('platform');
  const state = useStoreState(cart);
  const entities = useEntities();
  const queued = useStoreState(outbox).items;
  const tr = useT();

  const filled = state.platformRef.trim() !== '';
  const valid = platformRefSchema.safeParse(state.platformRef).success;
  const duplicate =
    valid &&
    isPlatformChannel(state.channel) &&
    duplicatePlatformRef(
      entities.orders.values(),
      queued.flatMap((item) =>
        item.kind === 'order' ? [{ channel: item.channel, note: item.note }] : [],
      ),
      state.channel,
      state.platformRef,
    );

  return (
    <div className="platform">
      <div className="field-group">
        <label className="label" htmlFor="platform-ref">
          {tr('platform.ref')}
        </label>
        <input
          id="platform-ref"
          className="input"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={PLATFORM_REF_MAX}
          placeholder={tr('platform.refPlaceholder')}
          disabled={locked}
          value={state.platformRef}
          aria-invalid={filled && !valid}
          onChange={(event) => cart.setPlatformRef(event.target.value)}
        />
      </div>
      {duplicate ? (
        <p className="notice" role="status">
          <Icon name="alert" />
          <span>{tr('platform.duplicate')}</span>
        </p>
      ) : null}
      <p className="hint">{tr('platform.hint')}</p>
    </div>
  );
}
