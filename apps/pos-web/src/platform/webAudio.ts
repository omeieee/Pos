/**
 * The web implementation of the `AudioEngine` (sound.ts): WebAudio oscillators. The chimes are
 * made by code, so there is no audio file to host and nothing for the CSP (`default-src 'self'`)
 * to allow. Not covered by tests: how it sounds, and what iOS Safari really does (taps, the
 * background, the silent switch). Those need a real device.
 *
 * iOS rules this respects:
 * - the context is made, resumed and given a one-sample silent buffer INSIDE the tap, in the same
 *   tick as `unlock()` is called (Safari counts the audio as unlocked only then);
 * - the context can become `interrupted` (page in the background, a call): `isRunning()` reads the
 *   real state each time and listeners hear about changes;
 * - nothing is created before the first `unlock()`, so no "not allowed to start" warning appears
 *   at start-up.
 */
import type { AudioEngine, SoundKind } from './sound.ts';

type ContextFactory = () => AudioContext | null;

/** Safari before 14.5 only has the prefixed constructor. */
interface AudioWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

const constructorOf = () => {
  const scope = globalThis as unknown as AudioWindow;
  return scope.AudioContext ?? scope.webkitAudioContext;
};

const defaultFactory: ContextFactory = () => {
  const Ctor = constructorOf();
  return Ctor ? new Ctor() : null;
};

/** Is there an audio output API at all? Asked without making a context. */
const defaultDetect = () => constructorOf() !== undefined;

interface Note {
  /** Hertz. */
  hz: number;
  /** Seconds from the start of the sound. */
  at: number;
  /** Seconds the note lasts. */
  length: number;
}

/** Two rising notes: a doorbell, clear over a noisy kitchen. */
const NEW_ORDER: readonly Note[] = [
  { hz: 880, at: 0, length: 0.2 },
  { hz: 1318.5, at: 0.22, length: 0.4 },
];
/** Three short, higher beeps: "an order is still waiting". */
const REMINDER: readonly Note[] = [
  { hz: 1568, at: 0, length: 0.14 },
  { hz: 1568, at: 0.2, length: 0.14 },
  { hz: 1568, at: 0.4, length: 0.14 },
];
const PEAK_GAIN = 0.4;

const NOTES: Record<SoundKind, readonly Note[]> = { newOrder: NEW_ORDER, reminder: REMINDER };

/** Events that count as a user gesture for audio on iOS (a touchstart does not). */
const GESTURES = ['touchend', 'click', 'keydown'] as const;

export function createWebAudioEngine(
  options: { create?: ContextFactory; detect?: () => boolean } = {},
): AudioEngine {
  const create = options.create ?? defaultFactory;
  const detect = options.detect ?? defaultDetect;
  let context: AudioContext | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** The context, made on first use. Null where the browser has no audio output. */
  function ensure(): AudioContext | null {
    if (context) return context;
    try {
      context = create();
    } catch {
      context = null;
    }
    context?.addEventListener('statechange', notify);
    return context;
  }

  function unlock(): Promise<boolean> {
    const ctx = ensure();
    if (!ctx) return Promise.resolve(false);
    // All of this runs now, in the tap: resume, then a silent one-sample buffer.
    const resumed = ctx.resume();
    try {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, 22_050);
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // The resume above is what matters; the silent buffer only helps older iOS.
    }
    return resumed.then(
      () => ctx.state === 'running',
      () => false,
    );
  }

  return {
    get supported() {
      return detect();
    },
    unlock,
    async revive() {
      try {
        await context?.resume();
      } catch {
        // No tap, no sound: the state stays "blocked" and the person is told.
      }
    },
    isRunning: () => context?.state === 'running',
    play(kind) {
      const ctx = context;
      if (ctx?.state !== 'running') return false;
      const start = ctx.currentTime + 0.02;
      for (const note of NOTES[kind]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = note.hz;
        const from = start + note.at;
        gain.gain.setValueAtTime(0.0001, from);
        gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, from + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, from + note.length);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(from);
        osc.stop(from + note.length + 0.05);
      }
      return true;
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    unlockOnGesture() {
      const handler = () => {
        void unlock().then((running) => {
          if (running) stop();
        });
      };
      const stop = () => {
        for (const type of GESTURES) document.removeEventListener(type, handler, true);
      };
      for (const type of GESTURES) document.addEventListener(type, handler, true);
      return stop;
    },
  };
}
