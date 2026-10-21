import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { imageSize } from '../slips/image.ts';
import { prepareReceiptImage, ReceiptImageError } from './receipt-image.ts';

/** A picture whose left half is red and right half blue, as RGBA. */
function halves(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const left = x < width / 2;
      data[at] = left ? 220 : 20;
      data[at + 1] = 20;
      data[at + 2] = left ? 20 : 220;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

const asJpeg = (width: number, height: number) =>
  Buffer.from(jpeg.encode(halves(width, height), 90).data);

/** Inserts an EXIF APP1 segment with just the orientation tag after the JPEG start marker. */
function withOrientation(file: Buffer, orientation: number, bigEndian = false): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write(bigEndian ? 'MM' : 'II', 0, 'latin1');
  const w16 = (v: number, at: number) =>
    bigEndian ? tiff.writeUInt16BE(v, at) : tiff.writeUInt16LE(v, at);
  const w32 = (v: number, at: number) =>
    bigEndian ? tiff.writeUInt32BE(v, at) : tiff.writeUInt32LE(v, at);
  w16(42, 2);
  w32(8, 4); // IFD0 at offset 8
  w16(1, 8); // one entry
  w16(0x0112, 10); // Orientation
  w16(3, 12); // SHORT
  w32(1, 14);
  w16(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([file.subarray(0, 2), segment, body, file.subarray(2)]);
}

const decode = (bytes: Buffer) => jpeg.decode(bytes, { useTArray: true });
const pixel = (img: { data: Uint8Array; width: number }, x: number, y: number) => {
  const at = (y * img.width + x) * 4;
  return { r: img.data[at] as number, b: img.data[at + 2] as number };
};

describe('prepareReceiptImage', () => {
  test('shrinks a large picture so the longest side is 1280 and gives a JPEG', async () => {
    const out = await prepareReceiptImage(asJpeg(2400, 1600));
    expect(imageSize(out.bytes)).toEqual({ width: 1280, height: 853 });
    expect(out).toMatchObject({ width: 1280, height: 853 });
    expect(out.bytes[0]).toBe(0xff);
    expect(out.bytes[1]).toBe(0xd8);
    // The colours survive the shrink.
    const img = decode(out.bytes);
    expect(pixel(img, 100, 400).r).toBeGreaterThan(150);
    expect(pixel(img, 1100, 400).b).toBeGreaterThan(150);
  });

  test('never enlarges a small picture', async () => {
    const out = await prepareReceiptImage(asJpeg(400, 300));
    expect(imageSize(out.bytes)).toEqual({ width: 400, height: 300 });
  });

  test('a PNG becomes a JPEG, and transparency lands on white', async () => {
    const png = new PNG({ width: 40, height: 20 });
    png.data.fill(0); // fully transparent
    const out = await prepareReceiptImage(PNG.sync.write(png));
    const img = decode(out.bytes);
    expect(pixel(img, 5, 5).r).toBeGreaterThan(240);
    expect(pixel(img, 5, 5).b).toBeGreaterThan(240);
  });

  test('stays near the size target for a noisy photo', async () => {
    const { data, width, height } = halves(1600, 1200);
    let seed = 7;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (data[i] as number) ^ (seed & 0x3f);
      data[i + 1] = (data[i + 1] as number) ^ ((seed >> 6) & 0x3f);
    }
    const noisy = Buffer.from(jpeg.encode({ data, width, height }, 95).data);
    const out = await prepareReceiptImage(noisy);
    expect(out.bytes.length).toBeLessThan(260 * 1024);
  });

  test('EXIF orientation is applied, then dropped from the file', async () => {
    // Stored 200x100, red left. Orientation 6 = show rotated 90 degrees clockwise: red ends on top.
    const out = await prepareReceiptImage(withOrientation(asJpeg(200, 100), 6));
    expect(imageSize(out.bytes)).toEqual({ width: 100, height: 200 });
    const img = decode(out.bytes);
    expect(pixel(img, 50, 20).r).toBeGreaterThan(150);
    expect(pixel(img, 50, 180).b).toBeGreaterThan(150);
    expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
  });

  test.each([
    // orientation, expected size, where red (the stored left half) appears
    [1, 200, 100, 'left'],
    [2, 200, 100, 'right'],
    [3, 200, 100, 'right'],
    [4, 200, 100, 'left'],
    [5, 100, 200, 'top'],
    [6, 100, 200, 'top'],
    [7, 100, 200, 'bottom'],
    [8, 100, 200, 'bottom'],
  ] as const)('orientation %i', async (orientation, w, h, red) => {
    const out = await prepareReceiptImage(withOrientation(asJpeg(200, 100), orientation, true));
    expect(imageSize(out.bytes)).toEqual({ width: w, height: h });
    const img = decode(out.bytes);
    const probe = {
      left: [w * 0.2, h / 2],
      right: [w * 0.8, h / 2],
      top: [w / 2, h * 0.2],
      bottom: [w / 2, h * 0.8],
    }[red];
    expect(
      pixel(img, Math.floor(probe[0] as number), Math.floor(probe[1] as number)).r,
    ).toBeGreaterThan(150);
  });

  test('refuses what is not a JPEG or PNG, a WebP, a lie and a huge picture', async () => {
    const code = async (bytes: Buffer) =>
      prepareReceiptImage(bytes).then(
        () => 'ok',
        (e: unknown) => (e instanceof ReceiptImageError ? e.code : 'other'),
      );
    expect(await code(Buffer.from('<html>not a picture at all, just text</html>'))).toBe(
      'unsupported',
    );
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([40, 0, 0, 0]),
      Buffer.from('WEBP'),
      Buffer.alloc(40),
    ]);
    expect(await code(webp)).toBe('unsupported');
    // JPEG magic bytes with garbage after them.
    expect(
      await code(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)])),
    ).toBe('undecodable');
    // A PNG header that promises 20000 x 20000 pixels: refused before any decoding.
    const png = new PNG({ width: 4, height: 4 });
    const big = PNG.sync.write(png);
    big.writeUInt32BE(20_000, 16);
    big.writeUInt32BE(20_000, 20);
    expect(await code(big)).toBe('too_large');
  });
});
