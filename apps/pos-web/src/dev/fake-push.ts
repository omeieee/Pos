/**
 * A fake `PushPlatform` for tests and for the dev mock (`VITE_MOCK_API=1`): no browser push, no
 * network, nothing is ever delivered. It answers like the web implementation does: a subscription
 * has an allowed push host and keys of the shape the shared schema accepts, a blocked permission
 * refuses, and a closed prompt leaves the permission at `default`.
 */

import {
  type DeviceSubscription,
  type PushPermission,
  type PushPlatform,
  PushPlatformError,
  sameKey,
} from '../platform/push.ts';
import { MOCK_VAPID_PUBLIC_KEY } from './mock-push.ts';

export interface FakePushOptions {
  /** `unsupported`: no push in this browser; `needs-install`: an iPhone or iPad in a Safari tab. */
  availability?: 'available' | 'needs-install' | 'unsupported';
  permission?: PushPermission;
  /** What the permission prompt answers when it is shown. */
  prompt?: PushPermission;
  /** A subscription this browser already holds. */
  subscription?: DeviceSubscription | null;
  /** The next `subscribe()` fails with this (after the permission step). */
  failSubscribe?: boolean;
}

let counter = 0;

/** A subscription that passes `pushSubscriptionInputSchema`; `key` is the VAPID key it was made for. */
export function fakeSubscription(key: string | null = MOCK_VAPID_PUBLIC_KEY): DeviceSubscription {
  counter += 1;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/fake-${counter}`,
    keys: { p256dh: `B${'B'.repeat(86)}`, auth: 'A'.repeat(22) },
    applicationServerKey: key,
  };
}

export function createFakePush(options: FakePushOptions = {}) {
  let availability = options.availability ?? 'available';
  let permission: PushPermission = options.permission ?? 'default';
  let prompt: PushPermission = options.prompt ?? 'granted';
  let subscription: DeviceSubscription | null = options.subscription ?? null;
  let failSubscribe = options.failSubscribe ?? false;
  /** What the page asked of this fake, in order, for a test to read. */
  const calls: string[] = [];

  const platform: PushPlatform = {
    isSupported: () => availability === 'available',
    needsInstall: () => availability === 'needs-install',
    permission: () => permission,
    subscribe(publicKey) {
      calls.push('subscribe');
      if (availability !== 'available') return Promise.reject(new PushPlatformError('unsupported'));
      // Like the web one: the prompt starts now, the rest after it.
      const asking: Promise<PushPermission> =
        permission === 'default'
          ? Promise.resolve(prompt).then((answer) => {
              permission = answer;
              return answer;
            })
          : Promise.resolve(permission);
      return asking.then((answer) => {
        if (answer === 'denied') throw new PushPlatformError('denied');
        if (answer !== 'granted') throw new PushPlatformError('dismissed');
        if (failSubscribe) throw new PushPlatformError('failed');
        if (
          subscription?.applicationServerKey &&
          sameKey(subscription.applicationServerKey, publicKey)
        ) {
          return subscription;
        }
        subscription = fakeSubscription(publicKey);
        return subscription;
      });
    },
    async unsubscribe() {
      calls.push('unsubscribe');
      subscription = null;
    },
    async getSubscription() {
      calls.push('getSubscription');
      return subscription;
    },
  };

  return {
    platform,
    calls,
    /** Change what this fake browser is like, as a settings change or a new install would. */
    set(next: FakePushOptions) {
      if (next.availability !== undefined) availability = next.availability;
      if (next.permission !== undefined) permission = next.permission;
      if (next.prompt !== undefined) prompt = next.prompt;
      if (next.subscription !== undefined) subscription = next.subscription;
      if (next.failSubscribe !== undefined) failSubscribe = next.failSubscribe;
    },
    held: () => subscription,
  };
}
