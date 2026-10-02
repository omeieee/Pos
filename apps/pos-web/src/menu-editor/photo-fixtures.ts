/**
 * Made-up picture bytes for tests: a JPEG and a WebP that pass the shared header check, with or
 * without an EXIF block. The GPS numbers are invented (rule 10: no real data in tests).
 */

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A tiny JPEG header (SOI, optional APPn segment, one frame header, SOS, filler, EOI). */
export function fakeJpeg(
  total: number,
  segment?: { app: number; text: string },
  size = { width: 800, height: 600 },
): Uint8Array<ArrayBuffer> {
  const out: number[] = [0xff, 0xd8];
  if (segment) {
    const body = ascii(segment.text);
    out.push(0xff, segment.app, ...be16(body.length + 2), ...body);
  }
  // SOF0: length 11, 8 bits, height, width, one component
  out.push(0xff, 0xc0, ...be16(11), 8, ...be16(size.height), ...be16(size.width), 1, 1, 0x11, 0);
  out.push(0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0);
  while (out.length < total - 2) out.push(0x55);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

/** A camera JPEG: an APP1 segment starting `Exif\0\0` holding a made-up GPS block. */
export function fakeExifJpeg(): Uint8Array<ArrayBuffer> {
  return fakeJpeg(2000, { app: 0xe1, text: 'Exif\0\0MM\0*GPSLatitudeRef=N GPSLatitude=13.0000' });
}

/** A lossy WebP of `total` bytes, optionally followed by an extra metadata chunk. */
export function fakeWebp(total: number, extra?: 'EXIF' | 'XMP '): Uint8Array<ArrayBuffer> {
  const vp8 = [
    ...ascii('VP8 '),
    ...le32(10),
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...[800 & 0xff, (800 >> 8) & 0xff, 600 & 0xff, (600 >> 8) & 0xff],
  ];
  const chunks = [...vp8];
  if (extra) chunks.push(...ascii(extra), ...le32(4), 1, 2, 3, 4);
  const body = [...ascii('WEBP'), ...chunks];
  while (body.length + 8 < total) body.push(0);
  return Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body]);
}

/** A blob of a given type and size, for an encoder double (the bytes are not a real picture). */
export function sizedBlob(type: string, size: number): Blob {
  const bytes =
    type === 'image/webp'
      ? fakeWebp(size)
      : type === 'image/jpeg'
        ? fakeJpeg(size)
        : new Uint8Array(size);
  return new Blob([bytes], { type });
}
