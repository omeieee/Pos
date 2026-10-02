/** Moves to a page of the hash router: `goTo('/orders/abc')` shows `#/orders/abc`. */
export function goTo(path: string): void {
  window.location.hash = `#${path}`;
}
