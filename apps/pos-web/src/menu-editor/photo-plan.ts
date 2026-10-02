/**
 * Getting a menu photo ready to upload (D-21). The server stores whatever valid image it gets and
 * does NOT strip location data, so the app must: every photo is decoded, drawn on a canvas and
 * encoded again, which leaves the camera's EXIF block (GPS position, time, device) behind.
 *
 * This file is the plan and the guard, with no browser API in it: the browser's part (decode,
 * canvas, encode) sits behind `PhotoEngine` in `platform/photo.ts`, so the plan is tested here and
 * a native shell can bring its own engine.
 *
 * - Longest side `PHOTO_TARGET_SIDE` (800 px), never enlarged.
 * - WebP first (smallest). A browser that cannot encode it answers PNG (Safari does): the next try
 *   is JPEG, and the plan stays on JPEG. The type that is sent is the blob's own, never a guess.
 * - Quality steps down, then the size, until the file is at most about 150 KB; a file up to the
 *   server cap is accepted when 150 KB is out of reach, above the cap it is refused here.
 * - Last guard: the finished bytes are scanned for metadata (EXIF, XMP, IPTC) and refused if any
 *   is there, whatever the encoder did.
 */
import { PHOTO_MAX_BYTES } from '@sds/shared';

export const PHOTO_TARGET_SIDE = 800;
export const PHOTO_TARGET_BYTES = 150_000;
const SIDE_STEPS = [PHOTO_TARGET_SIDE, 640, 480] as const;
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45] as const;

export type PhotoType = 'image/webp' | 'image/jpeg';

export type PhotoFailure = 'unreadable' | 'unsupported' | 'too_big' | 'metadata';

/** Why a photo could not be prepared: a code for the screen, never a file name or content. */
export class PhotoError extends Error {
  readonly reason: PhotoFailure | 'bad_size';
  constructor(reason: PhotoFailure | 'bad_size') {
    super(reason);
    this.name = 'PhotoError';
    this.reason = reason;
  }
}

/** The browser's side: open a picture, then draw and encode it at a size. */
export interface PhotoSource {
  /** Pixel size after the camera's rotation is applied (a portrait photo is taller than wide). */
  width: number;
  height: number;
  /** Draws the picture on a white canvas of this size and encodes it. */
  encode(width: number, height: number, type: PhotoType, quality: number): Promise<Blob>;
  close(): void;
}
export interface PhotoEngine {
  open(file: Blob): Promise<PhotoSource>;
}

/** The size that fits inside `maxSide` on the long side, in whole pixels, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PhotoError('bad_size');
  }
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height };
  const scale = maxSide / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ---------- The metadata guard ----------

export type MetadataKind = 'exif' | 'xmp' | 'iptc';

const text = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));
const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const le32 = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
const be32 = (b: Uint8Array, i: number) => (be16(b, i) * 65536 + be16(b, i + 2)) >>> 0;

function jpegMetadata(b: Uint8Array): MetadataKind | null {
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return null;
    while (b[pos] === 0xff) pos++;
    const marker = b[pos];
    pos++;
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null; // the picture starts
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = be16(b, pos);
    if (length < 2) return null;
    if (marker === 0xe1) {
      // APP1: EXIF or XMP; either way a camera's block.
      return text(b, pos + 2, 4) === 'Exif' ? 'exif' : 'xmp';
    }
    if (marker === 0xed) return 'iptc'; // APP13 (Photoshop / IPTC)
    pos += length;
  }
  return null;
}

function webpMetadata(b: Uint8Array): MetadataKind | null {
  let pos = 12;
  while (pos + 8 <= b.length) {
    const kind = text(b, pos, 4);
    if (kind === 'EXIF') return 'exif';
    if (kind === 'XMP ') return 'xmp';
    pos += 8 + le32(b, pos + 4) + (le32(b, pos + 4) % 2);
  }
  return null;
}

function pngMetadata(b: Uint8Array): MetadataKind | null {
  let pos = 8;
  while (pos + 8 <= b.length) {
    const kind = text(b, pos + 4, 4);
    if (kind === 'eXIf') return 'exif';
    if (kind === 'iTXt' || kind === 'tEXt' || kind === 'zTXt') return 'xmp';
    pos += 12 + be32(b, pos);
  }
  return null;
}

/** The marks a camera leaves, written out so a hidden copy is found even where no segment starts. */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const XMP_HEADER = [...'http://ns.adobe.com/xap'].map((c) => c.charCodeAt(0));

function contains(bytes: Uint8Array, needle: readonly number[]): boolean {
  const first = needle[0] ?? 0;
  for (let i = bytes.indexOf(first); i !== -1; i = bytes.indexOf(first, i + 1)) {
    if (needle.every((v, k) => bytes[i + k] === v)) return true;
  }
  return false;
}

/**
 * Which kind of camera metadata is in these image bytes, if any: the structure of a JPEG, WebP or
 * PNG is walked for its metadata segments or chunks, then the whole file is searched for an EXIF
 * or XMP header. A canvas output has none of them.
 */
export function findMetadata(bytes: Uint8Array): MetadataKind | null {
  let found: MetadataKind | null = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) found = jpegMetadata(bytes);
  else if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP')
    found = webpMetadata(bytes);
  else if (bytes[0] === 0x89 && text(bytes, 1, 3) === 'PNG') found = pngMetadata(bytes);
  if (found) return found;
  if (contains(bytes, EXIF_HEADER)) return 'exif';
  if (contains(bytes, XMP_HEADER)) return 'xmp';
  return null;
}

// ---------- The plan ----------

const served = (type: string): type is PhotoType => type === 'image/webp' || type === 'image/jpeg';

/**
 * Re-encodes a chosen picture for upload, or throws a `PhotoError`. The returned blob has a type
 * the server serves (WebP or JPEG), is at most the server cap, and carries no camera metadata.
 */
export async function preparePhoto(file: Blob, engine: PhotoEngine): Promise<Blob> {
  let source: PhotoSource;
  try {
    source = await engine.open(file);
  } catch {
    throw new PhotoError('unreadable');
  }
  try {
    let type: PhotoType = 'image/webp';
    let smallest: Blob | null = null;
    for (const side of SIDE_STEPS) {
      const { width, height } = fitWithin(source.width, source.height, side);
      for (const quality of QUALITY_STEPS) {
        let blob = await source.encode(width, height, type, quality);
        if (type === 'image/webp' && blob.type !== 'image/webp') {
          // This browser cannot encode WebP (it answered PNG or something else): JPEG from here on.
          type = 'image/jpeg';
          blob = await source.encode(width, height, type, quality);
        }
        if (!served(blob.type)) throw new PhotoError('unsupported');
        if (blob.size <= PHOTO_TARGET_BYTES) return await checked(blob);
        if (smallest === null || blob.size < smallest.size) smallest = blob;
      }
    }
    if (smallest !== null && smallest.size <= PHOTO_MAX_BYTES) return await checked(smallest);
    throw new PhotoError('too_big');
  } finally {
    source.close();
  }
}

async function checked(blob: Blob): Promise<Blob> {
  if (findMetadata(new Uint8Array(await blob.arrayBuffer())) !== null) {
    throw new PhotoError('metadata');
  }
  return blob;
}
