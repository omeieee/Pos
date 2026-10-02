import { createStore, type ReadableStore } from './store.ts';

/**
 * A counter of work that a page reload would lose: a cart with lines, an order being sent, later a
 * payment in progress. The app applies a waiting update only while it is idle. A screen calls
 * `begin()` when such work starts and the function it returns when the work ends.
 */
export interface Activity extends ReadableStore<{ count: number }> {
  isBusy(): boolean;
  begin(): () => void;
}

export function createActivity(): Activity {
  const store = createStore({ count: 0 });
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    isBusy: () => store.getState().count > 0,
    begin() {
      store.setState({ count: store.getState().count + 1 });
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        store.setState({ count: store.getState().count - 1 });
      };
    },
  };
}
