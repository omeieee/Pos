import type { LocalStore } from './localStore.ts';
import type { SoundPrefs } from './sound.ts';

export const SOUND_KEY = 'sound.enabled';

/**
 * The remembered "sound on" choice, per device, in the local store (the key-value area that
 * survives a reload). It is NOT in the token store: a sign-out must not forget how a kitchen
 * screen is set up. `open` is called on first use, so the store (and Dexie behind it) loads only
 * when the sound is first looked at.
 */
export function createSoundPrefs(open: () => Promise<LocalStore>): SoundPrefs {
  let store: Promise<LocalStore> | null = null;
  const get = () => {
    store ??= open();
    return store;
  };
  return {
    async load() {
      const value = await (await get()).kv.get<unknown>(SOUND_KEY);
      return typeof value === 'boolean' ? value : undefined;
    },
    async save(enabled) {
      await (await get()).kv.set(SOUND_KEY, enabled);
    },
  };
}
