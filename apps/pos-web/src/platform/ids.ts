/**
 * Random ids for idempotency keys. `crypto.randomUUID` only exists in secure contexts
 * (https or localhost), so an iPad opening the dev server over a LAN address would have none;
 * `getRandomValues` works everywhere, so it is the fallback.
 */

type CryptoLike = {
  randomUUID?: (() => string) | undefined;
  getRandomValues: Crypto['getRandomValues'];
};

const hex = (byte: number) => byte.toString(16).padStart(2, '0');

export function newUuid(source: CryptoLike = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  // RFC 4122 version 4: set the version and variant bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(bytes, hex);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h
    .slice(8, 10)
    .join('')}-${h.slice(10, 16).join('')}`;
}
