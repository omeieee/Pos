/**
 * The customer app's session (D-06, docs/04 §1.5). A LIFF login that LINE has verified becomes a
 * short-lived signed token tied to ONE customer row. Nothing is stored: the token is
 * `sds_cst.<payload>.<signature>`, an HMAC over the payload with a key derived from
 * AUTH_SECRET_KEY (HKDF purpose `customer-session`), so a staff token and a customer token can
 * never stand in for each other.
 *
 * It carries no staff permission and `guard()` (staff) rejects it. On EVERY request the guard
 * also reads the customer row again, so an erased customer (PDPA) or a changed LINE id ends the
 * session at once, whatever the token still says.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lineRepo } from '@sds/db';
import type { FastifyRequest } from 'fastify';
import { markCustomerGuard } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { unauthenticated } from '../errors.ts';

/** A session lasts as long as a LIFF ID token does (an hour); the app signs in again after that. */
export const CUSTOMER_SESSION_SECONDS = 3600;

const PREFIX = 'sds_cst';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the customer guard on every `/v1/app` route that needs a signed-in customer. */
    customer: CustomerPrincipal | null;
  }
}

/** Who the customer guard found. The LINE user id never leaves the server. */
export interface CustomerPrincipal {
  customerId: string;
  lineUserId: string;
  privacyAckVersion: string | null;
}

const mac = (key: Buffer, payload: string) =>
  createHmac('sha256', key).update(`customer-session:${payload}`).digest();

export function signCustomerToken(key: Buffer, customerId: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ c: customerId, e: expiresAt })).toString(
    'base64url',
  );
  return `${PREFIX}.${payload}.${mac(key, payload).toString('base64url')}`;
}

/** The customer id inside a genuine, unexpired token, or null for anything else. */
export function readCustomerToken(key: Buffer, token: string, nowSeconds: number): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts as [string, string, string];
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  // Only the canonical encoding (the last base64url character carries spare bits).
  if (given.toString('base64url') !== signature) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      c?: unknown;
      e?: unknown;
    };
    if (typeof body.c !== 'string' || typeof body.e !== 'number') return null;
    return nowSeconds > body.e ? null : body.c;
  } catch {
    return null;
  }
}

const BEARER = /^Bearer (sds_cst\.[A-Za-z0-9_-]{20,400}\.[A-Za-z0-9_-]{43})$/;

/** `onRequest` guard of the customer routes. Always the same 401: it never says why. */
export function createCustomerGuard(ctx: Pick<AuthContext, 'db' | 'keys' | 'now'>) {
  return markCustomerGuard(async (request: FastifyRequest) => {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw unauthenticated();
    const customerId = readCustomerToken(
      ctx.keys.customerSessionKey,
      token,
      Math.floor(ctx.now().getTime() / 1000),
    );
    if (!customerId) throw unauthenticated();
    const live = await lineRepo.findLiveCustomer(ctx.db, customerId);
    if (!live) throw unauthenticated();
    request.customer = {
      customerId: live.id,
      lineUserId: live.lineUserId,
      privacyAckVersion: live.privacyAckVersion,
    };
  });
}

/** The principal the customer guard set. A route without the guard has none: fail closed. */
export function customerOf(request: FastifyRequest): CustomerPrincipal {
  if (!request.customer) throw unauthenticated();
  return request.customer;
}
