/**
 * Test seams for Web Push: a transport that records what would go to a push service (no network),
 * and a "browser" that owns a subscription key pair and can decrypt what was sent to it. The
 * decryption is written from RFC 8291 section 3.4 on its own, so a test reads exactly what a real
 * browser would.
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { generateVapidKeys, type PushRequest, type PushTransport } from '../push/webpush.ts';

export const TEST_VAPID = {
  ...generateVapidKeys(),
  subject: 'mailto:owner@example.test',
};

export interface FakeBrowser {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The JSON the browser would receive in a request addressed to it. */
  decrypt(request: PushRequest): unknown;
}

const fromB64 = (text: string) => Buffer.from(text, 'base64url');

/** A subscriber with real keys. `host` picks the push service the endpoint names. */
export function newBrowser(host = 'fcm.googleapis.com'): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const p256dh = ecdh.getPublicKey().toString('base64url');
  return {
    endpoint: `https://${host}/fcm/send/${randomBytes(12).toString('hex')}`,
    p256dh,
    auth: authSecret.toString('base64url'),
    decrypt(request) {
      const body = Buffer.from(request.body);
      const salt = body.subarray(0, 16);
      const idLength = body[20] ?? 0;
      const senderPoint = body.subarray(21, 21 + idLength);
      const sealed = body.subarray(21 + idLength);
      const shared = ecdh.computeSecret(senderPoint);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), fromB64(p256dh), senderPoint]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
      const cek = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      );
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      );
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const padded = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      // Padding is zeros after the data; the last record ends with 0x02.
      let end = padded.length - 1;
      while (end >= 0 && padded[end] === 0) end -= 1;
      if (padded[end] !== 0x02) throw new Error('missing the final record delimiter');
      return JSON.parse(padded.subarray(0, end).toString('utf8'));
    },
  };
}

export interface FakePush {
  transport: PushTransport;
  /** Every request, in the order it was sent. */
  requests: PushRequest[];
  /** What to answer for an endpoint: a status, or `'throw'`, or `'hang'` (never answers until aborted). Default 201. */
  answer(endpoint: string, outcome: number | 'throw' | 'hang'): void;
  /** The most requests that were in flight at the same moment. */
  maxInFlight(): number;
  /** The requests sent to one endpoint. */
  sentTo(endpoint: string): PushRequest[];
  reset(): void;
}

/** `delayMs` keeps each answer waiting a moment, so concurrent sends overlap. */
export function createFakePush(delayMs = 0): FakePush {
  const requests: PushRequest[] = [];
  const outcomes = new Map<string, number | 'throw' | 'hang'>();
  let inFlight = 0;
  let maxInFlight = 0;

  async function answerFor(request: PushRequest, signal: AbortSignal): Promise<{ status: number }> {
    const outcome = outcomes.get(request.endpoint) ?? 201;
    if (outcome === 'throw') throw new TypeError(`fetch failed for ${request.endpoint}`);
    if (outcome === 'hang') {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return { status: outcome === 'hang' ? 0 : outcome };
  }

  return {
    requests,
    transport: async (request, signal) => {
      requests.push(request);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await answerFor(request, signal);
      } finally {
        inFlight -= 1;
      }
    },
    answer: (endpoint, outcome) => void outcomes.set(endpoint, outcome),
    maxInFlight: () => maxInFlight,
    sentTo: (endpoint) => requests.filter((r) => r.endpoint === endpoint),
    reset() {
      requests.length = 0;
      outcomes.clear();
      maxInFlight = 0;
    },
  };
}
