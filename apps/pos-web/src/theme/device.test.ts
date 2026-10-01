import { baseTokens, deviceDefaults } from '@sds/ui';
import { describe, expect, test } from 'vitest';
import { LAPTOP_MIN_WIDTH, PHONE_MAX_WIDTH, pickDevice, suggestedKind, tokensCss } from './device.ts';

const view = (width: number, coarsePointer: boolean) => ({ width, coarsePointer });

describe('pickDevice', () => {
  test('the registered kind wins over the screen', () => {
    expect(pickDevice('laptop', view(390, true))).toBe('laptop');
    expect(pickDevice('iphone', view(1440, false))).toBe('iphone');
    expect(pickDevice('ipad', view(390, true))).toBe('ipad');
  });

  test('a device without a staff-screen kind falls back to the screen', () => {
    expect(pickDevice('print_agent', view(390, true))).toBe('iphone');
    expect(pickDevice('display', view(1180, true))).toBe('ipad');
    expect(pickDevice(null, view(390, true))).toBe('iphone');
  });

  test('the target screens', () => {
    expect(pickDevice(null, view(390, true))).toBe('iphone'); // iPhone portrait
    expect(pickDevice(null, view(1180, true))).toBe('ipad'); // iPad landscape
    expect(pickDevice(null, view(820, true))).toBe('ipad'); // iPad portrait
    expect(pickDevice(null, view(1440, false))).toBe('laptop');
  });

  test('boundaries', () => {
    expect(pickDevice(null, view(PHONE_MAX_WIDTH, false))).toBe('iphone');
    expect(pickDevice(null, view(PHONE_MAX_WIDTH + 1, false))).toBe('ipad');
    expect(pickDevice(null, view(LAPTOP_MIN_WIDTH - 1, false))).toBe('ipad');
    expect(pickDevice(null, view(LAPTOP_MIN_WIDTH, false))).toBe('laptop');
    // A big iPad (1366 wide) is still touch.
    expect(pickDevice(null, view(1366, true))).toBe('ipad');
  });

  test('suggests a kind for registration from the screen alone', () => {
    expect(suggestedKind(view(1180, true))).toBe('ipad');
  });
});

describe('tokensCss', () => {
  test('emits the token variables from packages/ui for the device', () => {
    const css = tokensCss('ipad');
    expect(css).toContain(':root {');
    expect(css).toContain(`--sds-color-brand: ${baseTokens.color.brand};`);
    expect(css).toContain(`--sds-touch-min: ${deviceDefaults.ipad.touch?.min};`);
    expect(tokensCss('iphone')).toContain(`--sds-touch-min: ${deviceDefaults.iphone.touch?.min};`);
  });
});
