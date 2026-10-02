import type { MessageKey } from '@sds/i18n';
import type { IconName } from '../app/routes.ts';
import type { SoundState } from '../platform/sound.ts';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

const STATE_ICON: Record<SoundState, IconName> = {
  on: 'volume',
  off: 'volume-off',
  blocked: 'volume-off',
  unsupported: 'volume-off',
};

/**
 * The new-order sound switch of the kitchen view. It always says what the sound is doing now (on,
 * off, blocked) in words and an icon, never by colour alone. iOS Safari plays audio only after a
 * tap, so the button is what unlocks it: `turnOn()` is called straight from the click, before
 * anything is awaited. "Blocked" means the sound is chosen but the browser has not let it start (or
 * stopped it again): one tap fixes it. The choice is remembered on this device.
 */
export function SoundControl() {
  const { sound } = useServices();
  const { state } = useStoreState(sound);
  const tr = useT();

  const action: { label: MessageKey; run: () => void } | null =
    state === 'on'
      ? { label: 'kitchen.sound.turnOff', run: () => void sound.turnOff() }
      : state === 'off'
        ? { label: 'kitchen.sound.turnOn', run: () => void sound.turnOn() }
        : state === 'blocked'
          ? { label: 'kitchen.sound.unblock', run: () => void sound.turnOn() }
          : null;
  const hint: MessageKey | null =
    state === 'off'
      ? 'kitchen.sound.hint.off'
      : state === 'blocked'
        ? 'kitchen.sound.hint.blocked'
        : state === 'unsupported'
          ? 'kitchen.sound.hint.unsupported'
          : null;

  return (
    <fieldset className="ksound">
      <legend className="visually-hidden">{tr('kitchen.sound.label')}</legend>
      <div className="ksound__row">
        <span
          className={`status ksound__state ksound__state--${state}`}
          role="status"
          aria-live="polite"
        >
          <Icon name={STATE_ICON[state]} />
          <span>{tr(`kitchen.sound.state.${state}`)}</span>
        </span>
        {action ? (
          <button
            type="button"
            className={`btn ksound__btn${state === 'on' ? ' btn-soft' : ' btn-primary'}`}
            onClick={action.run}
          >
            {tr(action.label)}
          </button>
        ) : null}
      </div>
      {hint ? <p className="muted small ksound__hint">{tr(hint)}</p> : null}
    </fieldset>
  );
}
