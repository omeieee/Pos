/** The few element members we touch, so this can be tested without a DOM. */
export interface IsolatableElement {
  inert: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Makes everything next to `keep` unreachable (inert: no focus, no taps, hidden from screen
 * readers) while a dialog is open, so Tab cannot walk into the page behind it. Returns a
 * function that puts each sibling back exactly as it was.
 */
export function isolateSiblings(
  siblings: ArrayLike<IsolatableElement>,
  keep: IsolatableElement,
): () => void {
  const restores: (() => void)[] = [];
  for (const element of Array.from(siblings)) {
    if (element === keep) continue;
    const wasInert = element.inert;
    const hadHidden = element.getAttribute('aria-hidden');
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
    restores.push(() => {
      element.inert = wasInert;
      if (hadHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', hadHidden);
    });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
