import { describe, expect, test, vi } from 'vitest';
import { createMemoryLocalStore } from './localStore.ts';
import { createPaymentPopupPrefs, PAYMENT_POPUP_KEY } from './paymentPopupPrefs.ts';

describe('the remembered payment pop-up choice', () => {
  test('is nothing at first, then what was saved, in the local store key-value area', async () => {
    const store = createMemoryLocalStore();
    const prefs = createPaymentPopupPrefs(async () => store);
    expect(await prefs.load()).toBeUndefined();
    await prefs.save(true);
    expect(await prefs.load()).toBe(true);
    expect(await store.kv.get(PAYMENT_POPUP_KEY)).toBe(true);
    await prefs.save(false);
    expect(await prefs.load()).toBe(false);
  });

  test('survives a new prefs object over the same store (a reload)', async () => {
    const store = createMemoryLocalStore();
    await createPaymentPopupPrefs(async () => store).save(true);
    expect(await createPaymentPopupPrefs(async () => store).load()).toBe(true);
  });

  test('a value of the wrong kind is ignored', async () => {
    const store = createMemoryLocalStore();
    await store.kv.set(PAYMENT_POPUP_KEY, 'yes');
    expect(await createPaymentPopupPrefs(async () => store).load()).toBeUndefined();
  });

  test('opens the store only when first used, and once', async () => {
    const store = createMemoryLocalStore();
    const open = vi.fn(async () => store);
    const prefs = createPaymentPopupPrefs(open);
    expect(open).not.toHaveBeenCalled();
    await prefs.load();
    await prefs.save(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
