/** A slip is a photo or screenshot: JPEG, PNG or WebP, at most 5 MB. */
export const MAX_SLIP_BYTES = 5 * 1024 * 1024;

export type SlipMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** Content types the upload route accepts as a header; the bytes are checked as well. */
export const SLIP_CONTENT_TYPES: readonly SlipMime[] = ['image/jpeg', 'image/png', 'image/webp'];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, i) => bytes[at + i] === byte);

/**
 * What the BYTES say the file is (never the header the client sent): JPEG (FF D8 FF), PNG (the
 * 8-byte signature) or WebP (`RIFF`, four size bytes, `WEBP`). Anything else is null.
 */
export function sniffSlip(bytes: Uint8Array): SlipMime | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}
