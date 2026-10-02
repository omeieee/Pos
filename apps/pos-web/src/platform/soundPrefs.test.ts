import { describe, expect, test, vi } from 'vitest';
import { createMemoryLocalStore } from './localStore.ts';
import { createSoundPrefs, SOUND_KEY } from './soundPrefs.ts';

describe('the remembered sound choice', () => {
  test('is nothing at first, then what was saved, in the local store key-value area', async () => {
    const store = createMemoryLocalStore();
    const prefs = createSoundPrefs(async () => store);
    expect(await prefs.load()).toBeUndefined();
    await prefs.save(true);
    expect(await prefs.load()).toBe(true);
    expect(await store.kv.get(SOUND_KEY)).toBe(true);
    await prefs.save(false);
    expect(await prefs.load()).toBe(false);
  });

  test('survives a new prefs object over the same store (a reload)', async () => {
    const store = createMemoryLocalStore();
    await createSoundPrefs(async () => store).save(true);
    expect(await createSoundPrefs(async () => store).load()).toBe(true);
  });

  test('a value of the wrong kind is ignored', async () => {
    const store = createMemoryLocalStore();
    await store.kv.set(SOUND_KEY, 'yes');
    expect(await createSoundPrefs(async () => store).load()).toBeUndefined();
  });

  test('opens the store only when first used, and once', async () => {
    const store = createMemoryLocalStore();
    const open = vi.fn(async () => store);
    const prefs = createSoundPrefs(open);
    expect(open).not.toHaveBeenCalled();
    await prefs.load();
    await prefs.save(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
