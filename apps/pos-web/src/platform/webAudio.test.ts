// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWebAudioEngine } from './webAudio.ts';

/** A WebAudio context that records what is scheduled. It starts suspended, like iOS Safari. */
function fakeContext(options: { resumes?: boolean } = {}) {
  const log = {
    oscillators: [] as { frequency: { value: number }; type: string; started: number[] }[],
    buffers: 0,
    resumeCalls: 0,
    created: 0,
  };
  const listeners = new Set<() => void>();
  const context = {
    state: 'suspended' as string,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {
      log.resumeCalls += 1;
      if (options.resumes !== false) {
        context.state = 'running';
        for (const l of listeners) l();
      }
    }),
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }),
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        started: [] as number[],
        connect: vi.fn(),
        start: (t: number) => osc.started.push(t),
        stop: vi.fn(),
      };
      log.oscillators.push(osc);
      return osc;
    },
    createBuffer: () => {
      log.buffers += 1;
      return {};
    },
    createBufferSource: () => ({ buffer: null, connect: vi.fn(), start: vi.fn() }),
    addEventListener: (_: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
  };
  return {
    context,
    log,
    create: () => {
      log.created += 1;
      return context as unknown as AudioContext;
    },
    interrupt() {
      context.state = 'interrupted';
      for (const l of listeners) l();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('the web audio engine', () => {
  test('makes no context until the first unlock (so no browser warning at start-up)', () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    expect(f.log.created).toBe(0);
    expect(engine.isRunning()).toBe(false);
    expect(engine.supported).toBe(true);
  });

  test('unlock makes one context, resumes it and plays a silent buffer inside the same call', async () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    const pending = engine.unlock();
    // Synchronously, before any await: this is what keeps it inside the tap.
    expect(f.log.created).toBe(1);
    expect(f.context.resume).toHaveBeenCalledTimes(1);
    expect(f.log.buffers).toBe(1);
    expect(await pending).toBe(true);
    expect(engine.isRunning()).toBe(true);
    await engine.unlock();
    expect(f.log.created).toBe(1);
  });

  test('a context that stays suspended is reported as not running', async () => {
    const f = fakeContext({ resumes: false });
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    expect(await engine.unlock()).toBe(false);
    expect(engine.isRunning()).toBe(false);
  });

  test('where there is no AudioContext it is unsupported and every call is harmless', async () => {
    const engine = createWebAudioEngine({ create: () => null, detect: () => false });
    expect(engine.supported).toBe(false);
    expect(await engine.unlock()).toBe(false);
    expect(engine.play('newOrder')).toBe(false);
    await engine.revive();
  });

  test('the new-order chime is two rising notes, the reminder three higher beeps', async () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    await engine.unlock();
    expect(engine.play('newOrder')).toBe(true);
    const chime = f.log.oscillators.map((o) => o.frequency.value);
    expect(chime).toHaveLength(2);
    expect(chime[1]).toBeGreaterThan(chime[0] ?? Number.POSITIVE_INFINITY);
    f.log.oscillators.length = 0;
    expect(engine.play('reminder')).toBe(true);
    expect(f.log.oscillators).toHaveLength(3);
    // Scheduled from the context's clock, one after the other.
    const starts = f.log.oscillators.map((o) => o.started[0] ?? 0);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[0]).toBeGreaterThanOrEqual(10);
  });

  test('does not play while the output is stopped', async () => {
    const f = fakeContext({ resumes: false });
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    await engine.unlock();
    expect(engine.play('newOrder')).toBe(false);
    expect(f.log.oscillators).toHaveLength(0);
  });

  test('tells its listeners when the output stops (an iOS interruption) and starts', async () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    const seen: boolean[] = [];
    const stop = engine.onStateChange(() => seen.push(engine.isRunning()));
    await engine.unlock();
    f.interrupt();
    expect(seen).toEqual([true, false]);
    stop();
    f.interrupt();
    expect(seen).toHaveLength(2);
  });

  test('revive resumes an existing context without a tap and swallows a refusal', async () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    await engine.revive();
    expect(f.log.created).toBe(0);
    await engine.unlock();
    f.interrupt();
    await engine.revive();
    expect(f.log.resumeCalls).toBe(2);
    f.context.resume.mockRejectedValueOnce(new Error('NotAllowedError'));
    f.interrupt();
    await expect(engine.revive()).resolves.toBeUndefined();
  });

  test('unlock on the next tap: listens for a tap or key, unlocks inside it, and then stops listening', async () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    engine.unlockOnGesture();
    expect(f.log.created).toBe(0);
    document.dispatchEvent(new Event('touchend'));
    expect(f.log.created).toBe(1);
    await vi.waitFor(() => expect(engine.isRunning()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new Event('click'));
    expect(f.context.resume).toHaveBeenCalledTimes(1);
  });

  test('a stopped wait never unlocks', () => {
    const f = fakeContext();
    const engine = createWebAudioEngine({ create: f.create, detect: () => true });
    const stop = engine.unlockOnGesture();
    stop();
    document.dispatchEvent(new Event('click'));
    expect(f.log.created).toBe(0);
  });
});
