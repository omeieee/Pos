/**
 * Sound seam: a chime for a new order. Features call `SoundPlayer`; the P10 shells (Capacitor,
 * Electron) can swap the `AudioEngine` (native audio) or the whole player and no screen changes.
 * `webAudio.ts` is the web engine (WebAudio oscillators: no audio file to host, nothing for the
 * CSP to allow).
 *
 * Two things are kept apart:
 * - the CHOICE (`enabled`): the person turned sound on, remembered per device in `SoundPrefs` (the
 *   local store, never the token store);
 * - the OUTPUT (`running`): whether the browser lets us make noise right now. iOS Safari allows
 *   audio only after a tap, and it can stop the output again when the page goes to the background.
 *
 * So after a reload with the choice on, the output is not running yet: the state is `blocked`
 * until a tap. The player arms a one-time "unlock on the next tap" for exactly that case, so the
 * first tap after sign-in (a PIN key) brings the sound back by itself. The explicit control calls
 * `turnOn()` from a tap handler.
 *
 * `turnOn()` MUST be called synchronously inside the tap handler: the engine's `unlock()` runs in
 * the same tick, before any `await` (a browser counts an awaited call as outside the tap).
 */
import type { ReadableStore } from '../lib/store.ts';
import { createStore } from '../lib/store.ts';
import type { Lifecycle } from './lifecycle.ts';

/** `newOrder`: two rising notes. `reminder`: three short, higher beeps (an order is still waiting). */
export type SoundKind = 'newOrder' | 'reminder';

export interface AudioEngine {
  /** False where there is no audio output API at all. */
  readonly supported: boolean;
  /** Starts the output. Call it synchronously from a tap. Resolves to whether it is running. */
  unlock(): Promise<boolean>;
  /** Tries to bring a stopped output back without a tap (it may stay stopped). Never throws. */
  revive(): Promise<void>;
  isRunning(): boolean;
  /** Plays a short sound now; false when it could not. */
  play(kind: SoundKind): boolean;
  /** Called when the output starts or stops. */
  onStateChange(listener: () => void): () => void;
  /** Unlocks the output on the next tap or key press. Returns a function that stops waiting. */
  unlockOnGesture(): () => void;
}

export interface SoundPrefs {
  load(): Promise<boolean | undefined>;
  save(enabled: boolean): Promise<void>;
}

export type SoundState = 'off' | 'on' | 'blocked' | 'unsupported';

export interface SoundSnapshot {
  /** The person's choice, remembered on this device. */
  enabled: boolean;
  /** The output is running right now. */
  running: boolean;
  supported: boolean;
  /** The remembered choice has been read. */
  loaded: boolean;
  state: SoundState;
}

export interface SoundPlayer extends ReadableStore<SoundSnapshot> {
  /** Reads the remembered choice. Call once at start-up; a second call does nothing. */
  init(): Promise<void>;
  /** Turns sound on. Call it synchronously from a tap handler. */
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  /** Plays when the state is `on`; false (and silent) otherwise. */
  play(kind: SoundKind): boolean;
}

export function soundState(parts: Pick<SoundSnapshot, 'enabled' | 'running' | 'supported'>) {
  if (!parts.supported) return 'unsupported';
  if (!parts.enabled) return 'off';
  return parts.running ? 'on' : 'blocked';
}

export function createSound(deps: {
  engine: AudioEngine;
  prefs: SoundPrefs;
  lifecycle: Pick<Lifecycle, 'subscribe'>;
}): SoundPlayer {
  const { engine, prefs } = deps;
  const snapshot = (enabled: boolean, loaded: boolean): SoundSnapshot => {
    const running = engine.isRunning();
    const parts = { enabled, running, supported: engine.supported };
    return { ...parts, loaded, state: soundState(parts) };
  };
  const store = createStore<SoundSnapshot>(snapshot(false, false));
  let disarm: (() => void) | null = null;
  let started = false;

  const refresh = (enabled = store.getState().enabled, loaded = store.getState().loaded) =>
    store.setState(snapshot(enabled, loaded));

  /** While the choice is on and the output is stopped, wait for the next tap to start it. */
  function rearm() {
    const { enabled, running, supported } = store.getState();
    const need = enabled && supported && !running;
    if (need && !disarm) disarm = engine.unlockOnGesture();
    if (!need && disarm) {
      disarm();
      disarm = null;
    }
  }

  engine.onStateChange(() => {
    refresh();
    rearm();
  });
  deps.lifecycle.subscribe({
    visible() {
      // The page is back: the output may have been stopped while it was away.
      if (store.getState().enabled && !engine.isRunning()) void engine.revive();
      refresh();
      rearm();
    },
  });

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    async init() {
      if (started) return;
      started = true;
      const saved = await prefs.load().catch(() => undefined);
      refresh(saved === true, true);
      rearm();
    },

    async turnOn() {
      // First, synchronously, inside the tap: nothing may come before this call.
      const unlocking = engine.unlock();
      refresh(true);
      const running = await unlocking.catch(() => false);
      refresh();
      rearm();
      // A short chime shows the person that the sound works.
      if (running) engine.play('newOrder');
      await prefs.save(true).catch(() => undefined);
    },

    async turnOff() {
      refresh(false);
      rearm();
      await prefs.save(false).catch(() => undefined);
    },

    play(kind) {
      const state = store.getState();
      if (state.state !== 'on' || !engine.isRunning()) {
        // The output stopped since we last looked: show it and wait for a tap.
        refresh();
        rearm();
        return false;
      }
      return engine.play(kind);
    },
  };
}
