import { describe, expect, test } from 'vitest';
import { type IsolatableElement, isolateSiblings } from './isolate.ts';

function fakeElement(attributes: Record<string, string> = {}, inert = false): IsolatableElement {
  const attrs = new Map(Object.entries(attributes));
  return {
    inert,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
  };
}

describe('isolateSiblings', () => {
  test('hides every sibling but the dialog, and puts them back exactly', () => {
    const page = fakeElement();
    const alreadyHidden = fakeElement({ 'aria-hidden': 'false' });
    const alreadyInert = fakeElement({}, true);
    const dialog = fakeElement();

    const restore = isolateSiblings([page, dialog, alreadyHidden, alreadyInert], dialog);
    expect(page.inert).toBe(true);
    expect(page.getAttribute('aria-hidden')).toBe('true');
    expect(alreadyHidden.inert).toBe(true);
    expect(dialog.inert).toBe(false);
    expect(dialog.getAttribute('aria-hidden')).toBeNull();

    restore();
    expect(page.inert).toBe(false);
    expect(page.getAttribute('aria-hidden')).toBeNull();
    expect(alreadyHidden.getAttribute('aria-hidden')).toBe('false');
    expect(alreadyInert.inert).toBe(true); // it was inert before; it stays so
  });

  test('with no siblings it does nothing', () => {
    const dialog = fakeElement();
    expect(() => isolateSiblings([dialog], dialog)()).not.toThrow();
  });
});
