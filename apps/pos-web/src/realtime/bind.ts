/**
 * Ties the realtime connection to sign-in: it runs while someone is signed in and the entity store
 * is emptied on the way out, so the next person on the device (a kitchen role after a manager)
 * never sees rows the previous role could read. The auth store stays free of realtime.
 */
import type { AuthPhase } from '../auth/auth-store.ts';
import type { ReadableStore } from '../lib/store.ts';
import type { EntityStore } from './entity-store.ts';

export function bindRealtime(deps: {
  auth: ReadableStore<{ phase: AuthPhase }>;
  connection: { start(): void; stop(): void };
  entities: Pick<EntityStore, 'reset'>;
  /** Called when the person leaves, to drop what belongs to them (the order on the screen). */
  onSignedOut?: () => void;
}): () => void {
  let active = false;

  function sync() {
    const signedIn = deps.auth.getState().phase === 'signedIn';
    if (signedIn === active) return;
    active = signedIn;
    if (signedIn) {
      deps.entities.reset();
      deps.connection.start();
    } else {
      deps.connection.stop();
      deps.entities.reset();
      deps.onSignedOut?.();
    }
  }

  const unsubscribe = deps.auth.subscribe(sync);
  sync();
  return unsubscribe;
}
