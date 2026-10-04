import type { StaffRole } from '@sds/shared';
import { type KeyboardEvent, useEffect, useReducer, useRef } from 'react';
import {
  canSubmitPin,
  emptyPin,
  keyToAction,
  type PinPadAction,
  pinPadReducer,
  pinSlots,
  shouldAutoSubmit,
} from '../auth/pin-pad.ts';
import { Gi } from '../design/icons.tsx';
import { useT } from './hooks.ts';
import './glass-forms.css';

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

/**
 * The large PIN pad. A full-length PIN signs in by itself; a shorter one needs OK, because a
 * wrong try counts toward a lock. Remount it (change its `key`) to clear it after a failure.
 * A hardware keyboard works too: digits, Backspace, Enter.
 */
export function PinPad({
  role,
  disabled,
  error,
  submitLabel,
  onSubmit,
}: {
  role: StaffRole;
  disabled: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (pin: string) => void;
}) {
  const tr = useT();
  const [state, dispatch] = useReducer(pinPadReducer, emptyPin);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  function press(action: PinPadAction) {
    if (disabled) return;
    dispatch(action);
    const next = pinPadReducer(state, action);
    if (action.type === 'digit' && shouldAutoSubmit(next)) onSubmit(next.digits);
  }

  function submit() {
    if (!disabled && canSubmitPin(state)) onSubmit(state.digits);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const action = keyToAction(event.key, event.target instanceof HTMLButtonElement);
    if (action === null) return;
    event.preventDefault();
    if (action === 'submit') submit();
    else press(action);
  }

  const entered = state.digits.length;
  const slots = pinSlots(role, entered);

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex lint/a11y/noStaticElementInteractions: the pad takes hardware-keyboard digits
    <div ref={root} className="pinpad" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="dots" role="img" aria-label={tr('auth.pin.progress', { count: entered })}>
        {Array.from({ length: slots }, (_, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length list of identical dots
            key={index}
            className={index < entered ? 'dot dot--on' : 'dot'}
          />
        ))}
      </div>
      <div className="gauth__pin-msg">
        {error ? (
          <p
            className="gfield__msg gfield__msg--bad"
            role="alert"
            style={{ justifyContent: 'center', textAlign: 'center', paddingLeft: 0, fontSize: 14 }}
          >
            <Gi n="warn" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
      <div className="keys">
        {DIGIT_ROWS.flat().map((digit) => (
          <button
            key={digit}
            type="button"
            className="key"
            disabled={disabled}
            onClick={() => press({ type: 'digit', digit })}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          className="key key--aux"
          disabled={disabled}
          onClick={() => press({ type: 'clear' })}
        >
          {tr('auth.pin.clear')}
        </button>
        <button
          type="button"
          className="key"
          disabled={disabled}
          onClick={() => press({ type: 'digit', digit: '0' })}
        >
          0
        </button>
        <button
          type="button"
          className="key key--aux"
          disabled={disabled}
          aria-label={tr('auth.pin.delete')}
          onClick={() => press({ type: 'delete' })}
        >
          <Gi n="backspace" />
        </button>
      </div>
      <button
        type="button"
        className="g-btn g-btn-p g-btn-lg g-btn-block"
        style={{ marginTop: 4 }}
        disabled={disabled || !canSubmitPin(state)}
        onClick={submit}
      >
        {submitLabel}
      </button>
    </div>
  );
}
