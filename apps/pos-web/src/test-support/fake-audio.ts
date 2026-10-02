/**
 * Test doubles for the sound and wake-lock seams. The engine only starts when `unlock()` is called,
 * like iOS Safari after a tap, so a test can show the blocked state and the unlock.
 */
import { vi } from 'vitest';
import type { AudioEngine, SoundKind, SoundPrefs } from '../platform/sound.ts';
import type { ScreenWakeLock } from '../platform/wakeLock.ts';

export function createFakeEngine(options: { supported?: boolean; unlocks?: boolean } = {}) {
  let running = false;
  const listeners = new Set<() => void>();
  const played: SoundKind[] = [];
  const order: string[] = [];
  const engine = {
    supported: options.supported ?? true,
    unlock: vi.fn(async () => {
      order.push('unlock');
      if (options.unlocks !== false) {
        running = true;
        for (const l of listeners) l();
      }
      return running;
    }),
    revive: vi.fn(async () => undefined),
    isRunning: () => running,
    play: vi.fn((kind: SoundKind) => {
      order.push(`play:${kind}`);
      played.push(kind);
      return true;
    }),
    onStateChange: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    unlockOnGesture: vi.fn(() => () => undefined),
  } satisfies AudioEngine;
  return {
    engine,
    played,
    order,
    /** The browser stops the output (iOS, page in the background). */
    stop() {
      running = false;
      for (const l of listeners) l();
    },
  };
}

export function createFakePrefs(initial?: boolean) {
  let value = initial;
  const prefs: SoundPrefs = {
    load: vi.fn(async () => value),
    save: vi.fn(async (enabled: boolean) => {
      value = enabled;
    }),
  };
  return { prefs, value: () => value };
}

export function createFakeWakeLock(supported = true) {
  let active = 0;
  const calls = { acquired: 0, released: 0 };
  const wakeLock: ScreenWakeLock = {
    supported,
    keepAwake() {
      calls.acquired += 1;
      active += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        calls.released += 1;
        active -= 1;
      };
    },
  };
  return { wakeLock, calls, active: () => active };
}
