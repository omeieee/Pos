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

/** The pixel size read from the file header, or null when the header is not understood. */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Width and height from the header only (no decoding), so a picture whose pixels would not fit in
 * memory can be refused before anything reads it: a 5 MB PNG can hold far more pixels than the
 * 1 GB shop server can decode. Null for anything unusual; the caller treats that as too risky.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (sniffSlip(bytes)) {
    case 'image/png':
      // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
      return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case 'image/jpeg':
      return jpegSize(bytes, view);
    case 'image/webp':
      return webpSize(bytes, view);
    default:
      return null;
  }
}

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // padding
      continue;
    }
    // Start-of-frame markers (not DHT C4, JPG C8 or DAC CC) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // markers without a length
      continue;
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 30) return null;
  const kind = String.fromCharCode(...bytes.subarray(12, 16));
  if (kind === 'VP8X') {
    // 24-bit width-1 and height-1, little endian, after the flags.
    const w = (bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16);
    const h = (bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (kind === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
