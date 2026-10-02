/**
 * Menu photo checks (D-21). Pure: no I/O, no Buffer, so the API and the browser share it. The
 * type is decided from the file's own bytes (magic numbers) and its size from the header; the
 * Content-Type a client sends is only compared with that, never believed. Every read is bounds
 * checked, so a hostile or truncated file gives `null`, never an exception.
 */

export const PHOTO_CONTENT_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

/** The stored file may not be larger than this (the owner accepted about 150 KB; a little headroom). */
export const PHOTO_MAX_BYTES = 200_000;
/** Longest side, in pixels. The app resizes to 800; this is the ceiling the server enforces. */
export const PHOTO_MAX_SIDE = 1200;

export interface ImageInfo {
  contentType: PhotoContentType;
  width: number;
  height: number;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  at + text.length <= bytes.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const be32 = (b: Uint8Array, i: number) => (be16(b, i) * 65536 + be16(b, i + 2)) >>> 0;
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, i: number) => le16(b, i) | ((b[i + 2] ?? 0) << 16);

const sized = (contentType: PhotoContentType, width: number, height: number): ImageInfo | null =>
  width > 0 && height > 0 ? { contentType, width, height } : null;

function sniffPng(b: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v)) return null;
  if (!ascii(b, 12, 'IHDR')) return null;
  return sized('image/png', be32(b, 16), be32(b, 20));
}

function sniffWebp(b: Uint8Array): ImageInfo | null {
  if (b.length < 25 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ') && b.length >= 30) {
    // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized('image/webp', le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const b1 = b[22] ?? 0;
    const width = (b[21] ?? 0) | ((b1 & 0x3f) << 8);
    const height = (b1 >> 6) | ((b[23] ?? 0) << 2) | (((b[24] ?? 0) & 0x0f) << 10);
    return sized('image/webp', width + 1, height + 1);
  }
  if (ascii(b, 12, 'VP8X') && b.length >= 30) {
    return sized('image/webp', le24(b, 24) + 1, le24(b, 27) + 1);
  }
  return null;
}

function sniffJpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let pos = 2;
  while (pos < b.length) {
    if (b[pos] !== 0xff) return null;
    while (b[pos] === 0xff) pos++; // fill bytes
    const marker = b[pos];
    if (marker === undefined) return null;
    pos++;
    // Markers with no length: TEM, RSTn, SOI.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // End of image, or the scan starts before any frame header was seen.
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    if (pos + 2 > b.length) return null;
    const length = be16(b, pos);
    if (length < 2 || pos + length > b.length) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (length < 7) return null;
      return sized('image/jpeg', be16(b, pos + 5), be16(b, pos + 3));
    }
    pos += length;
  }
  return null;
}

/** The type and pixel size from the file's own header, or `null` when it is not a PNG, JPEG or WebP. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return sniffPng(bytes) ?? sniffWebp(bytes) ?? sniffJpeg(bytes);
}

export type PhotoCheck =
  | { ok: true; info: ImageInfo }
  | {
      ok: false;
      reason: 'empty' | 'too_big' | 'not_an_image' | 'type_mismatch' | 'too_many_pixels';
    };

/** `image/png; charset=x` and `IMAGE/PNG` both mean `image/png`. */
const mediaType = (header: string | undefined) => header?.split(';')[0]?.trim().toLowerCase();

/**
 * The whole upload check: not empty, within the byte cap, really an image of a type we serve, a side
 * of at most `PHOTO_MAX_SIDE`, and the declared Content-Type agrees with what the bytes are.
 */
export function checkPhoto(bytes: Uint8Array, declaredContentType: string | undefined): PhotoCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > PHOTO_MAX_BYTES) return { ok: false, reason: 'too_big' };
  const info = sniffImage(bytes);
  if (!info) return { ok: false, reason: 'not_an_image' };
  if (mediaType(declaredContentType) !== info.contentType) {
    return { ok: false, reason: 'type_mismatch' };
  }
  if (info.width > PHOTO_MAX_SIDE || info.height > PHOTO_MAX_SIDE) {
    return { ok: false, reason: 'too_many_pixels' };
  }
  return { ok: true, info };
}
