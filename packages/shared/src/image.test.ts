import { describe, expect, test } from 'vitest';
import { checkPhoto, PHOTO_MAX_BYTES, PHOTO_MAX_SIDE, sniffImage } from './image.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function riff(chunk: number[]): number[] {
  return [...ascii('RIFF'), ...le32(4 + chunk.length), ...ascii('WEBP'), ...chunk];
}
/** Lossy: 'VP8 ' + frame tag (3 bytes), start code, 14-bit width and height. */
function webpLossy(width: number, height: number): Uint8Array {
  const payload = [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
  ];
  return Uint8Array.from(riff([...ascii('VP8 '), ...le32(payload.length), ...payload]));
}
function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  const bits = [w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f];
  const payload = [0x2f, ...bits];
  return Uint8Array.from(riff([...ascii('VP8L'), ...le32(payload.length), ...payload]));
}
function webpExtended(width: number, height: number): Uint8Array {
  const payload = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  return Uint8Array.from(riff([...ascii('VP8X'), ...le32(payload.length), ...payload]));
}

const u16 = (n: number) => [n >> 8, n & 255];
function jpeg(width: number, height: number, before: number[] = []): Uint8Array {
  const sof = [
    0xff,
    0xc0,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Uint8Array.from([0xff, 0xd8, ...before, ...sof, 0xff, 0xd9]);
}
const app0 = [0xff, 0xe0, ...u16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];

describe('sniffImage', () => {
  test('PNG: reads the size from IHDR', () => {
    expect(sniffImage(png(800, 600))).toEqual({
      contentType: 'image/png',
      width: 800,
      height: 600,
    });
  });

  test('WebP: lossy, lossless and extended layouts', () => {
    expect(sniffImage(webpLossy(640, 480))).toEqual({
      contentType: 'image/webp',
      width: 640,
      height: 480,
    });
    expect(sniffImage(webpLossless(800, 533))).toEqual({
      contentType: 'image/webp',
      width: 800,
      height: 533,
    });
    expect(sniffImage(webpLossless(16384, 16384))).toEqual({
      contentType: 'image/webp',
      width: 16384,
      height: 16384,
    });
    expect(sniffImage(webpExtended(1200, 900))).toEqual({
      contentType: 'image/webp',
      width: 1200,
      height: 900,
    });
  });

  test('JPEG: finds the start-of-frame after other segments, fill bytes and standalone markers', () => {
    expect(sniffImage(jpeg(800, 600))).toEqual({
      contentType: 'image/jpeg',
      width: 800,
      height: 600,
    });
    expect(sniffImage(jpeg(800, 600, app0))).toEqual({
      contentType: 'image/jpeg',
      width: 800,
      height: 600,
    });
    expect(sniffImage(jpeg(321, 123, [0xff, 0xff, 0xff, 0xd0, ...app0]))).toEqual({
      contentType: 'image/jpeg',
      width: 321,
      height: 123,
    });
    // Progressive (SOF2) counts; DHT (C4) and the arithmetic marker CC are not frames.
    const progressive = jpeg(100, 50);
    progressive[3] = 0xc2;
    expect(sniffImage(progressive)).toMatchObject({ width: 100, height: 50 });
    const dht = jpeg(100, 50);
    dht[3] = 0xc4;
    expect(sniffImage(dht)).toBeNull();
  });

  test('anything else is not an image: GIF, SVG, HTML, text, empty', () => {
    expect(sniffImage(Uint8Array.from(ascii('GIF89a\u0001\u0000\u0001\u0000')))).toBeNull();
    expect(
      sniffImage(Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))),
    ).toBeNull();
    expect(sniffImage(Uint8Array.from(ascii('<html><script>alert(1)</script>')))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(new Uint8Array(100))).toBeNull();
  });

  test('truncated or hostile headers return null and never throw', () => {
    const samples = [
      png(10, 10),
      webpLossy(10, 10),
      webpLossless(10, 10),
      webpExtended(10, 10),
      jpeg(10, 10, app0),
    ];
    for (const sample of samples) {
      for (let cut = 0; cut < sample.length; cut++) {
        expect(() => sniffImage(sample.slice(0, cut)), `cut ${cut}`).not.toThrow();
      }
    }
    // A JPEG segment that claims length 0 or 1 must not loop forever.
    expect(
      sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xe0, 0, 1])),
    ).toBeNull();
    // A JPEG segment longer than the file.
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2, 3]))).toBeNull();
    // A zero or absurd size is refused, not returned.
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(jpeg(0, 10))).toBeNull();
    // Random bytes behind each signature.
    for (const head of [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], ascii('RIFF')]) {
      const noise = Uint8Array.from([
        ...head,
        ...Array.from({ length: 60 }, (_, i) => (i * 37 + 11) & 255),
      ]);
      expect(() => sniffImage(noise)).not.toThrow();
    }
  });
});

describe('checkPhoto', () => {
  test('accepts a small image whose declared type matches', () => {
    expect(checkPhoto(png(800, 600), 'image/png')).toEqual({
      ok: true,
      info: { contentType: 'image/png', width: 800, height: 600 },
    });
    expect(checkPhoto(jpeg(1200, 1200), 'image/jpeg; charset=binary')).toMatchObject({ ok: true });
    expect(checkPhoto(webpLossy(800, 800), 'IMAGE/WEBP')).toMatchObject({ ok: true });
  });

  test('refuses what is not an image, whatever the client says', () => {
    expect(checkPhoto(Uint8Array.from(ascii('<svg/>')), 'image/png')).toEqual({
      ok: false,
      reason: 'not_an_image',
    });
    expect(checkPhoto(new Uint8Array(0), 'image/png')).toEqual({ ok: false, reason: 'empty' });
  });

  test('refuses a declared type that differs from the detected one', () => {
    expect(checkPhoto(png(10, 10), 'image/jpeg')).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(checkPhoto(png(10, 10), 'text/html')).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(checkPhoto(png(10, 10), undefined)).toEqual({ ok: false, reason: 'type_mismatch' });
  });

  test('refuses more than 1200 px on a side and more than the byte cap', () => {
    expect(PHOTO_MAX_SIDE).toBe(1200);
    expect(checkPhoto(png(1201, 100), 'image/png')).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
    expect(checkPhoto(png(100, 1201), 'image/png')).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
    expect(checkPhoto(png(1200, 1200), 'image/png')).toMatchObject({ ok: true });
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    big.set(png(10, 10));
    expect(checkPhoto(big, 'image/png')).toEqual({ ok: false, reason: 'too_big' });
    const exact = new Uint8Array(PHOTO_MAX_BYTES);
    exact.set(png(10, 10));
    expect(checkPhoto(exact, 'image/png')).toMatchObject({ ok: true });
  });
});
