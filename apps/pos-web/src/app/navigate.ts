/** Moves to a page of the hash router: `goTo('/orders/abc')` shows `#/orders/abc`. */
export function goTo(path: string): void {
  window.location.hash = `#${path}`;
}

/**
 * Forgets the page: the next sign-in lands on the first page its role may open (a kitchen role on
 * the kitchen view) instead of the page the last person left. No history entry is added.
 */
export function resetRoute(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
