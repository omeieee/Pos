/**
 * PIN entry rules for the pad. Sign-in accepts 4 to 6 digits for every role (the shared
 * `pinSchema`), and a wrong PIN counts toward a lock, so the pad never submits on its own below
 * the maximum length: a person with a 5 or 6 digit PIN must not burn an attempt at digit 4.
 */
import { PIN_MIN_DIGITS, pinSchema, type StaffRole } from '@sds/shared';

export const PIN_MAX_DIGITS = 6;

/**
 * How many dots to show before anything is typed: the shortest PIN the role may have (the
 * owner and managers have 6 digits). It only sizes the dots; the server decides whether a PIN
 * is right, and sign-in accepts 4 to 6 digits for everyone.
 */
export function pinSlots(role: StaffRole, entered: number): number {
  return Math.min(PIN_MAX_DIGITS, Math.max(PIN_MIN_DIGITS[role], entered));
}

export interface PinPadState {
  digits: string;
}

export const emptyPin: PinPadState = { digits: '' };

export type PinPadAction =
  | { type: 'digit'; digit: string }
  | { type: 'delete' }
  | { type: 'clear' };

export function pinPadReducer(state: PinPadState, action: PinPadAction): PinPadState {
  switch (action.type) {
    case 'digit':
      if (!/^\d$/.test(action.digit) || state.digits.length >= PIN_MAX_DIGITS) return state;
      return { digits: state.digits + action.digit };
    case 'delete':
      return state.digits === '' ? state : { digits: state.digits.slice(0, -1) };
    case 'clear':
      return state.digits === '' ? state : emptyPin;
  }
}

/** The OK button: a valid PIN for sign-in is 4 to 6 digits (the shared rule). */
export const canSubmitPin = (state: PinPadState): boolean =>
  pinSchema.safeParse(state.digits).success;

/** Only a full-length PIN submits by itself. */
export const shouldAutoSubmit = (state: PinPadState): boolean =>
  state.digits.length === PIN_MAX_DIGITS;

/**
 * A hardware keyboard on a laptop or an iPad: digits type, Backspace deletes, Enter submits.
 * Escape is left alone so it can still close a dialog.
 */
export function keyToAction(key: string): PinPadAction | 'submit' | null {
  if (/^\d$/.test(key)) return { type: 'digit', digit: key };
  if (key === 'Backspace') return { type: 'delete' };
  if (key === 'Enter') return 'submit';
  return null;
}

/** Whole seconds left on a lock learned from a 423 answer; 0 when there is none or it ended. */
export function lockSecondsLeft(lockedUntil: number | undefined, now: number): number {
  return lockedUntil === undefined ? 0 : Math.max(0, Math.ceil((lockedUntil - now) / 1000));
}
