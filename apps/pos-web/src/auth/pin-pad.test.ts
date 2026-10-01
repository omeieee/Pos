import { describe, expect, test } from 'vitest';
import {
  canSubmitPin,
  emptyPin,
  keyToAction,
  lockSecondsLeft,
  PIN_MAX_DIGITS,
  type PinPadAction,
  type PinPadState,
  pinPadReducer,
  pinSlots,
  shouldAutoSubmit,
} from './pin-pad.ts';

const press = (digits: string): PinPadState =>
  [...digits].reduce<PinPadState>(
    (state, digit) => pinPadReducer(state, { type: 'digit', digit }),
    emptyPin,
  );

describe('entering digits', () => {
  test('digits add up to the maximum and no further', () => {
    expect(press('1234').digits).toBe('1234');
    expect(press('1234567890').digits).toBe('123456');
    expect(PIN_MAX_DIGITS).toBe(6);
  });

  test('ignores anything that is not a single digit', () => {
    for (const digit of ['a', '', '12', ' ', '-', '٣']) {
      expect(pinPadReducer(emptyPin, { type: 'digit', digit })).toBe(emptyPin);
    }
  });

  test('delete removes the last digit; clear removes all; both are safe when empty', () => {
    expect(pinPadReducer(press('123'), { type: 'delete' }).digits).toBe('12');
    expect(pinPadReducer(press('123'), { type: 'clear' })).toBe(emptyPin);
    expect(pinPadReducer(emptyPin, { type: 'delete' })).toBe(emptyPin);
    expect(pinPadReducer(emptyPin, { type: 'clear' })).toBe(emptyPin);
  });

  test('does not mutate the previous state', () => {
    const before = press('12');
    pinPadReducer(before, { type: 'digit', digit: '3' });
    expect(before.digits).toBe('12');
  });
});

describe('when it can submit', () => {
  test('OK needs 4 to 6 digits, using the shared PIN rule', () => {
    expect(canSubmitPin(press(''))).toBe(false);
    expect(canSubmitPin(press('123'))).toBe(false);
    expect(canSubmitPin(press('1234'))).toBe(true);
    expect(canSubmitPin(press('12345'))).toBe(true);
    expect(canSubmitPin(press('123456'))).toBe(true);
  });

  test('only a full-length PIN submits by itself, so a 5 or 6 digit PIN never burns a try at digit 4', () => {
    expect(shouldAutoSubmit(press('1234'))).toBe(false);
    expect(shouldAutoSubmit(press('12345'))).toBe(false);
    expect(shouldAutoSubmit(press('123456'))).toBe(true);
  });
});

describe('dots', () => {
  test('the owner and managers see 6 dots, counter staff 4, growing up to 6 as they type', () => {
    expect(pinSlots('owner', 0)).toBe(6);
    expect(pinSlots('manager', 0)).toBe(6);
    expect(pinSlots('cashier', 0)).toBe(4);
    expect(pinSlots('kitchen', 0)).toBe(4);
    expect(pinSlots('cashier', 5)).toBe(5);
    expect(pinSlots('cashier', 6)).toBe(6);
    expect(pinSlots('cashier', 9)).toBe(6);
  });
});

describe('lock countdown', () => {
  test('counts down whole seconds and never goes below zero', () => {
    expect(lockSecondsLeft(undefined, 1000)).toBe(0);
    expect(lockSecondsLeft(301_000, 1000)).toBe(300);
    expect(lockSecondsLeft(1500, 1000)).toBe(1);
    expect(lockSecondsLeft(1000, 1000)).toBe(0);
    expect(lockSecondsLeft(500, 1000)).toBe(0);
  });
});

describe('Enter on a focused button', () => {
  test('is the button own click, not a submit, so a digit key still types its digit', () => {
    expect(keyToAction('Enter', true)).toBeNull();
    expect(keyToAction('Enter', false)).toBe('submit');
    // Digits and Backspace behave the same wherever the focus is.
    expect(keyToAction('5', true)).toEqual({ type: 'digit', digit: '5' });
    expect(keyToAction('Backspace', true)).toEqual({ type: 'delete' });
  });
});

describe('hardware keyboard', () => {
  test.each<[string, PinPadAction | 'submit' | null]>([
    ['7', { type: 'digit', digit: '7' }],
    ['Backspace', { type: 'delete' }],
    ['Enter', 'submit'],
    ['Escape', null],
    ['a', null],
    ['Tab', null],
    ['10', null],
  ])('%s', (key, expected) => {
    expect(keyToAction(key)).toEqual(expected);
  });
});
