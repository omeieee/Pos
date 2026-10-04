import { afterEach, describe, expect, test, vi } from 'vitest';
import { readStoredLocale, storeLocale } from './app-context.tsx';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the remembered language', () => {
  test('is what the customer picked last time', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(readStoredLocale()).toBeNull();
    storeLocale('en');
    expect(readStoredLocale()).toBe('en');
  });

  test('ignores a value that is not a language', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'sds.locale': 'fr' }));
    expect(readStoredLocale()).toBeNull();
  });

  test('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStoredLocale()).toBeNull();
    expect(() => storeLocale('th')).not.toThrow();
  });
});
