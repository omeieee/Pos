/**
 * A minimal observable store, so state and rules live outside React and run (and are tested)
 * without a DOM. Components read it with `useStore` (useSyncExternalStore).
 */
export interface ReadableStore<S> {
  getState(): S;
  subscribe(listener: () => void): () => void;
}

export interface Store<S> extends ReadableStore<S> {
  setState(patch: Partial<S>): void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(patch) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
