import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useEntities, useServices, useStoreState, useT } from '../ui/hooks.ts';
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
    <div
      className="g-sunk"
      style={s('padding:14px 16px;display:flex;flex-direction:column;gap:10px')}
    >
      <div style={s('display:flex;flex-direction:column;gap:6px')}>
        <label className="g-t-c" htmlFor="platform-ref">
          {tr('platform.ref')}
        </label>
        <div className="g-field" style={s('height:46px;border-radius:14px;font-size:14px')}>
          <Gi n="receipt2" size="sm" />
          <input
            id="platform-ref"
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
      </div>
      {duplicate ? (
        <p
          className="g-badge g-b-warn"
          role="status"
          style={s('height:auto;padding:8px 12px;white-space:normal')}
        >
          <Gi n="warn" />
          <span>{tr('platform.duplicate')}</span>
        </p>
      ) : null}
      <p className="g-t-c" style={s('margin:0')}>
        {tr('platform.hint')}
      </p>
    </div>
  );
}
