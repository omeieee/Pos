/**
 * Calls `onTick` every `intervalMs` until the returned function is called. This only wakes a
 * screen up; the screen reads the time itself (`Date.now()`) when it renders, so there is no
 * stored "now" that can go stale when the timer stops or the page was in the background.
 */
export function subscribeTicks(intervalMs: number, onTick: () => void): () => void {
  const id = setInterval(onTick, intervalMs);
  return () => clearInterval(id);
}
