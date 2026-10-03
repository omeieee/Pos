import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 as standard base64 is always 44 characters (32 bytes, one `=`). */
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Checks `X-Line-Signature`: the base64 HMAC-SHA256 of the RAW request body with the channel
 * secret. Pass the bytes LINE sent; a body parsed and serialised again would not match. The
 * comparison is constant-time and never throws: anything unexpected is "not valid".
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string | string[] | undefined,
  channelSecret: string,
): boolean {
  if (channelSecret === '' || typeof header !== 'string' || !BASE64_SHA256.test(header)) {
    return false;
  }
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  const given = Buffer.from(header, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
