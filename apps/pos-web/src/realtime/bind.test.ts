import { describe, expect, test, vi } from 'vitest';
import { createStore } from '../lib/store.ts';
import { socketUrl } from '../platform/socket.ts';
import { orderFrame, uuid } from '../test-support/frames.ts';
import { bindRealtime } from './bind.ts';
import { createEntityStore } from './entity-store.ts';

function setup(phase: 'booting' | 'unregistered' | 'locked' | 'signedIn' = 'locked') {
  const auth = createStore<{ phase: typeof phase }>({ phase });
  const connection = { start: vi.fn(), stop: vi.fn() };
  const entities = createEntityStore();
  const unbind = bindRealtime({ auth, connection, entities });
  return { auth, connection, entities, unbind };
}

describe('bindRealtime', () => {
  test('connects when a person signs in, and not before', () => {
    const { auth, connection } = setup('locked');
    expect(connection.start).not.toHaveBeenCalled();
    auth.setState({ phase: 'signedIn' });
    expect(connection.start).toHaveBeenCalledTimes(1);
  });

  test('already signed in at binding time: connects at once', () => {
    const { connection } = setup('signedIn');
    expect(connection.start).toHaveBeenCalledTimes(1);
  });

  test('sign-out closes the connection and empties the store, so the next person starts clean', () => {
    const { auth, connection, entities } = setup('signedIn');
    entities.apply(orderFrame(uuid(1), 5));
    auth.setState({ phase: 'locked' });
    expect(connection.stop).toHaveBeenCalledTimes(1);
    expect(entities.getState().orders.size).toBe(0);
    expect(entities.getState().lastRev).toBe(0);
  });

  test('signing in again starts from an empty store', () => {
    const { auth, connection, entities } = setup('signedIn');
    auth.setState({ phase: 'locked' });
    entities.apply(orderFrame(uuid(1), 5)); // a straggler
    auth.setState({ phase: 'signedIn' });
    expect(entities.getState().orders.size).toBe(0);
    expect(connection.start).toHaveBeenCalledTimes(2);
  });

  test('other changes of the auth state do nothing', () => {
    const { auth, connection } = setup('signedIn');
    auth.setState({ phase: 'signedIn' });
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(connection.stop).not.toHaveBeenCalled();
  });

  test('unbinding stops listening', () => {
    const { auth, connection, unbind } = setup('locked');
    unbind();
    auth.setState({ phase: 'signedIn' });
    expect(connection.start).not.toHaveBeenCalled();
  });
});

describe('socketUrl', () => {
  test('swaps the scheme and adds the socket path', () => {
    expect(socketUrl('https://api.example.test')).toBe('wss://api.example.test/v1/ws');
    expect(socketUrl('http://localhost:3000/')).toBe('ws://localhost:3000/v1/ws');
  });

  test('an empty base means the page origin', () => {
    expect(socketUrl('', { protocol: 'https:', host: 'pos.example.test' })).toBe(
      'wss://pos.example.test/v1/ws',
    );
  });
});
