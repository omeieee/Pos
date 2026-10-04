import type { MessageKey } from '@sds/i18n';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';

/**
 * The new-order sound switch of the kitchen view (design: the switch "เสียงออเดอร์ใหม่"). It always
 * says what the sound is doing now (on, off, blocked, not available) in words: a word beside the
 * switch when something needs attention, and for a screen reader always, never by colour alone.
 * iOS Safari plays audio only after a tap, so the switch is what unlocks it: `turnOn()` is called
 * straight from the click, before anything is awaited. "Blocked" means the sound is chosen but the
 * browser has not let it start (or stopped it again): one tap on the switch fixes it. The choice is
 * remembered on this device.
 */
export function SoundControl() {
  const { sound } = useServices();
  const { state } = useStoreState(sound);
  const tr = useT();

  const hint: MessageKey | null =
    state === 'off'
      ? 'kitchen.sound.hint.off'
      : state === 'blocked'
        ? 'kitchen.sound.hint.blocked'
        : state === 'unsupported'
          ? 'kitchen.sound.hint.unsupported'
          : null;
  // Off and on are told by the switch itself; the rest need a visible word and icon.
  const attention = state === 'blocked' || state === 'unsupported';

  return (
    <fieldset className="ksound" style={s('border:0;margin:0;padding:0;min-width:0')}>
      <legend className="visually-hidden">{tr('kitchen.sound.label')}</legend>
      <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap')}>
        <label
          className="g-t-s"
          style={s('display:flex;align-items:center;gap:10px;min-height:48px;cursor:pointer')}
        >
          <input
            type="checkbox"
            role="switch"
            aria-checked={state === 'on'}
            className="g-sw"
            checked={state === 'on'}
            disabled={state === 'unsupported'}
            aria-describedby={hint ? 'ksound-hint' : undefined}
            onChange={() => {
              if (state === 'on') void sound.turnOff();
              else void sound.turnOn();
            }}
          />
          {tr('kitchen.sound.short')}
        </label>
        <span
          role="status"
          aria-live="polite"
          className={
            attention
              ? `g-badge ${state === 'blocked' ? 'g-b-warn' : 'g-b-bad'}`
              : 'visually-hidden'
          }
        >
          {attention ? <Gi n="warn" /> : null}
          {tr(`kitchen.sound.state.${state}`)}
        </span>
      </div>
      {hint ? (
        <p
          id="ksound-hint"
          className={attention ? 'g-t-c' : 'visually-hidden'}
          style={s('margin:0;max-width:260px')}
        >
          {tr(hint)}
        </p>
      ) : null}
    </fieldset>
  );
}
