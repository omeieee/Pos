import { describe, expect, test, type vi } from 'vitest';
import { createFakeEngine, createFakePrefs } from '../test-support/fake-audio.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createSound, soundState } from './sound.ts';

function setup(over: { engine?: Parameters<typeof createFakeEngine>[0]; saved?: boolean } = {}) {
  const e = createFakeEngine(over.engine);
  const p = createFakePrefs(over.saved);
  const life = createFakeLifecycle();
  const sound = createSound({ engine: e.engine, prefs: p.prefs, lifecycle: life.lifecycle });
  return { ...e, ...p, sound, life };
}

describe('the state of the sound', () => {
  test('is off until turned on, unsupported without an output, blocked when chosen but not running', () => {
    expect(soundState({ enabled: false, running: false, supported: true })).toBe('off');
    expect(soundState({ enabled: true, running: true, supported: true })).toBe('on');
    expect(soundState({ enabled: true, running: false, supported: true })).toBe('blocked');
    expect(soundState({ enabled: true, running: true, supported: false })).toBe('unsupported');
  });
});

describe('start-up', () => {
  test('reads the remembered choice; nothing was chosen means off', async () => {
    const env = setup();
    expect(env.sound.getState()).toMatchObject({ state: 'off', loaded: false });
    await env.sound.init();
    expect(env.sound.getState()).toMatchObject({ state: 'off', loaded: true });
  });

  test('a remembered "on" is blocked until a tap, and it waits for that tap by itself', async () => {
    const env = setup({ saved: true });
    await env.sound.init();
    expect(env.sound.getState().state).toBe('blocked');
    expect(env.engine.unlockOnGesture).toHaveBeenCalledTimes(1);
    expect(env.sound.play('newOrder')).toBe(false);
    expect(env.engine.play).not.toHaveBeenCalled();
  });

  test('when the tap unlocks the output the state becomes on', async () => {
    const env = setup({ saved: true });
    await env.sound.init();
    await env.engine.unlock();
    expect(env.sound.getState().state).toBe('on');
    expect(env.sound.play('newOrder')).toBe(true);
  });

  test('init twice reads once', async () => {
    const env = setup({ saved: true });
    await env.sound.init();
    await env.sound.init();
    expect(env.prefs.load).toHaveBeenCalledTimes(1);
  });

  test('a failing read of the choice means off, not a crash', async () => {
    const env = setup();
    (env.prefs.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no storage'));
    await env.sound.init();
    expect(env.sound.getState()).toMatchObject({ state: 'off', loaded: true });
  });
});

describe('turning it on', () => {
  test('unlocks the output in the same tick as the tap, then chimes and remembers the choice', async () => {
    const env = setup();
    const done = env.sound.turnOn();
    // Nothing awaited yet: the unlock has already been requested.
    expect(env.engine.unlock).toHaveBeenCalledTimes(1);
    await done;
    expect(env.sound.getState().state).toBe('on');
    expect(env.order).toEqual(['unlock', 'play:newOrder']);
    expect(env.value()).toBe(true);
  });

  test('an output that will not start leaves the state blocked (chosen, but not running)', async () => {
    const env = setup({ engine: { unlocks: false } });
    await env.sound.turnOn();
    expect(env.sound.getState().state).toBe('blocked');
    expect(env.engine.play).not.toHaveBeenCalled();
    expect(env.value()).toBe(true);
    expect(env.engine.unlockOnGesture).toHaveBeenCalled();
  });

  test('a throwing unlock is blocked too, not an unhandled error', async () => {
    const env = setup();
    env.engine.unlock.mockRejectedValueOnce(new Error('NotAllowedError'));
    await env.sound.turnOn();
    expect(env.sound.getState().state).toBe('blocked');
  });

  test('a storage that fails does not stop the sound', async () => {
    const env = setup();
    (env.prefs.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('full'));
    await env.sound.turnOn();
    expect(env.sound.getState().state).toBe('on');
  });

  test('where there is no output it stays unsupported', async () => {
    const env = setup({ engine: { supported: false, unlocks: false } });
    await env.sound.turnOn();
    expect(env.sound.getState().state).toBe('unsupported');
    expect(env.sound.play('newOrder')).toBe(false);
  });
});

describe('turning it off', () => {
  test('is silent and remembered', async () => {
    const env = setup();
    await env.sound.turnOn();
    await env.sound.turnOff();
    expect(env.sound.getState().state).toBe('off');
    expect(env.value()).toBe(false);
    expect(env.sound.play('reminder')).toBe(false);
  });
});

describe('playing', () => {
  test('plays the kind that was asked for while on', async () => {
    const env = setup();
    await env.sound.turnOn();
    expect(env.sound.play('reminder')).toBe(true);
    expect(env.order.at(-1)).toBe('play:reminder');
  });

  test('when the browser stopped the output it says blocked, stays silent and waits for a tap', async () => {
    const env = setup();
    await env.sound.turnOn();
    env.stop();
    expect(env.sound.getState().state).toBe('blocked');
    expect(env.sound.play('newOrder')).toBe(false);
    expect(env.engine.unlockOnGesture).toHaveBeenCalled();
  });
});

describe('the page coming back to the front', () => {
  test('tries to bring a stopped output back, and shows the real state', async () => {
    const env = setup();
    await env.sound.turnOn();
    env.stop();
    env.life.show();
    expect(env.engine.revive).toHaveBeenCalledTimes(1);
    expect(env.sound.getState().state).toBe('blocked');
  });

  test('does nothing when the sound is off', async () => {
    const env = setup();
    await env.sound.init();
    env.life.show();
    expect(env.engine.revive).not.toHaveBeenCalled();
  });
});
