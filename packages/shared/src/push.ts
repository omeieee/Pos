/**
 * Web Push (P8, phone alerts): what a browser's push subscription must look like before the server
 * stores it and later calls its endpoint. Pure: no I/O.
 *
 * The endpoint is a URL the SERVER will call, so it is an SSRF risk: only the push services the
 * browsers themselves use are allowed, over https on the default port, by exact host or by a
 * dotted suffix (so `evilpush.apple.com` and `fcm.googleapis.com.evil.com` never match).
 */
import { z } from 'zod';

/** Chrome/Android (FCM), Firefox, and Safari's own host. */
export const PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const;

/**
 * Apple (`*.push.apple.com`) and Windows/Edge (`*.notify.windows.com`, which includes the
 * `wns2-*.notify.windows.com` hosts). Each needs at least one label in front.
 */
export const PUSH_ENDPOINT_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'] as const;

export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

/**
 * https, a plain DNS host, the default port (`:443` may be written out), an optional path and query.
 * No user info, no backslash, no whitespace, no trailing dot: the shape is checked by pattern (this
 * package has no URL type), so there is nothing for a URL parser to read differently.
 */
const ENDPOINT_SHAPE = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?(?:[/?][^\s\\#]*)?$/i;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) return false;
  const host = ENDPOINT_SHAPE.exec(endpoint)?.[1]?.toLowerCase();
  if (host === undefined) return false;
  if ((PUSH_ENDPOINT_HOSTS as readonly string[]).includes(host)) return true;
  return PUSH_ENDPOINT_HOST_SUFFIXES.some(
    (suffix) => host.length > suffix.length && host.endsWith(suffix),
  );
}

const base64Url = (pattern: RegExp) => z.string().regex(pattern);

/**
 * `PushSubscription.toJSON()`: an uncompressed P-256 point (65 bytes, starts 0x04, so the first
 * base64url character is `B`) and a 16-byte auth secret, both base64url without padding.
 * Other fields (`expirationTime`) are accepted and dropped: the object is not strict.
 */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z.string().max(PUSH_ENDPOINT_MAX_LENGTH).refine(isAllowedPushEndpoint, {
    error: 'must be an https endpoint of a known push service',
  }),
  keys: z.object({
    p256dh: base64Url(/^B[A-Za-z0-9_-]{86}$/),
    auth: base64Url(/^[A-Za-z0-9_-]{22}$/),
  }),
});
export type PushSubscriptionInput = z.output<typeof pushSubscriptionInputSchema>;

export const pushConfigResponseSchema = z.object({
  enabled: z.boolean(),
  /** The VAPID public key (base64url, 65 bytes): the browser's `applicationServerKey`. */
  publicKey: z.string().nullable(),
});
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;

export const pushSubscribedResponseSchema = z.object({ subscribed: z.boolean() });
export type PushSubscribedResponse = z.infer<typeof pushSubscribedResponseSchema>;

/** What a push message carries: a short title and body, a path inside the POS, a tag that replaces an older alert. */
export const pushPayloadSchema = z.object({
  title: z.string().max(120),
  body: z.string().max(200),
  /** A path in the POS app (`/#/orders/<id>`), never a full URL: `//host` and `/\host` are refused (off-origin). */
  url: z.string().regex(/^\/(?![/\\])[^\s\\]*$/),
  tag: z.string().max(100),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;
