import { PHOTO_MAX_BYTES, sniffImage } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { fakeExifJpeg, fakeJpeg, fakeWebp, sizedBlob } from './photo-fixtures.ts';
import {
  findMetadata,
  fitWithin,
  PHOTO_TARGET_BYTES,
  PHOTO_TARGET_SIDE,
  type PhotoEngine,
  PhotoError,
  preparePhoto,
} from './photo-plan.ts';

describe('fitWithin', () => {
  test('shrinks the long side to the limit and keeps the shape', () => {
    expect(fitWithin(4032, 3024, 800)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(3024, 4032, 800)).toEqual({ width: 600, height: 800 });
  });

  test('never enlarges a small picture', () => {
    expect(fitWithin(400, 300, 800)).toEqual({ width: 400, height: 300 });
    expect(fitWithin(800, 800, 800)).toEqual({ width: 800, height: 800 });
  });

  test('keeps at least one pixel on a very thin picture', () => {
    expect(fitWithin(10_000, 3, 800)).toEqual({ width: 800, height: 1 });
  });

  test('refuses a size that is not a positive whole number', () => {
    expect(() => fitWithin(0, 100, 800)).toThrow(PhotoError);
    expect(() => fitWithin(Number.NaN, 100, 800)).toThrow(PhotoError);
  });
});

describe('findMetadata: what a camera puts in a picture', () => {
  test('finds the EXIF block (where the GPS position lives) of a JPEG', () => {
    expect(findMetadata(fakeExifJpeg())).toBe('exif');
  });

  test('a clean JPEG has none', () => {
    expect(findMetadata(fakeJpeg(1000))).toBeNull();
  });

  test('finds the EXIF and XMP chunks of a WebP, and passes a clean one', () => {
    expect(findMetadata(fakeWebp(1000, 'EXIF'))).toBe('exif');
    expect(findMetadata(fakeWebp(1000, 'XMP '))).toBe('xmp');
    expect(findMetadata(fakeWebp(1000))).toBeNull();
  });

  test('finds XMP and IPTC segments of a JPEG', () => {
    expect(findMetadata(fakeJpeg(500, { app: 0xe1, text: 'http://ns.adobe.com/xap/1.0/\0' }))).toBe(
      'xmp',
    );
    expect(findMetadata(fakeJpeg(500, { app: 0xed, text: 'Photoshop 3.0\0' }))).toBe('iptc');
  });

  test('an Exif header hidden where no segment starts is still found', () => {
    const bytes = fakeJpeg(500);
    const hidden = new Uint8Array(bytes.length + 8);
    hidden.set(bytes);
    hidden.set([0x45, 0x78, 0x69, 0x66, 0, 0], bytes.length);
    expect(findMetadata(hidden)).toBe('exif');
  });

  test('bytes that are not an image have no metadata to find', () => {
    expect(findMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

/** A fake picture engine: every encode returns what `make` says, and counts the calls. */
function engine(
  make: (call: { width: number; height: number; type: string; quality: number }) => Blob,
  source = { width: 4032, height: 3024 },
) {
  const calls: { width: number; height: number; type: string; quality: number }[] = [];
  let closed = 0;
  const photoEngine: PhotoEngine = {
    async open() {
      return {
        ...source,
        async encode(width, height, type, quality) {
          const call = { width, height, type, quality };
          calls.push(call);
          return make(call);
        },
        close() {
          closed += 1;
        },
      };
    },
  };
  return { photoEngine, calls, closed: () => closed };
}

describe('preparePhoto', () => {
  const file = new Blob([fakeExifJpeg()], { type: 'image/jpeg' });

  test('resizes to about 800 px and sends a type the server serves, using the blob type', async () => {
    const e = engine(() => sizedBlob('image/webp', 60_000));
    const photo = await preparePhoto(file, e.photoEngine);
    expect(e.calls[0]).toMatchObject({ width: PHOTO_TARGET_SIDE, height: 600, type: 'image/webp' });
    expect(photo.type).toBe('image/webp');
    expect(photo.size).toBeLessThanOrEqual(PHOTO_TARGET_BYTES);
    expect(e.closed()).toBe(1);
  });

  test('Safari answers PNG when asked for WebP: it asks again for JPEG and keeps asking for JPEG', async () => {
    const e = engine(({ type }) =>
      type === 'image/webp' ? sizedBlob('image/png', 900_000) : sizedBlob('image/jpeg', 90_000),
    );
    const photo = await preparePhoto(file, e.photoEngine);
    expect(photo.type).toBe('image/jpeg');
    expect(e.calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg']);
  });

  test('lowers the quality, then the size, until the file is about 150 KB', async () => {
    // A browser that cannot encode WebP, and a picture that is big at 800 px until the quality drops.
    const forced = engine(({ type, width, quality }) =>
      type === 'image/webp'
        ? sizedBlob('image/png', 1_000_000)
        : sizedBlob('image/jpeg', width === 800 ? Math.round(quality * 400_000) : 100_000),
    );
    const photo = await preparePhoto(file, forced.photoEngine);
    expect(photo.size).toBeLessThanOrEqual(PHOTO_TARGET_BYTES);
    const jpegCalls = forced.calls.filter((c) => c.type === 'image/jpeg');
    expect(jpegCalls[0]?.quality).toBeGreaterThan(jpegCalls[1]?.quality ?? 1);
  });

  test('settles for a file under the server cap when 150 KB is out of reach, and refuses above it', async () => {
    const near = engine(() => sizedBlob('image/jpeg', 180_000));
    expect((await preparePhoto(file, near.photoEngine)).size).toBe(180_000);

    const huge = engine(() => sizedBlob('image/jpeg', PHOTO_MAX_BYTES + 1));
    await expect(preparePhoto(file, huge.photoEngine)).rejects.toMatchObject({ reason: 'too_big' });
  });

  test('refuses a file the browser cannot decode', async () => {
    const broken: PhotoEngine = {
      async open() {
        throw new Error('decode failed');
      },
    };
    await expect(preparePhoto(file, broken)).rejects.toMatchObject({ reason: 'unreadable' });
  });

  test('refuses what the browser handed back as a type the server does not serve', async () => {
    const e = engine(() => sizedBlob('image/png', 50_000));
    await expect(preparePhoto(file, e.photoEngine)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });

  test('NEVER lets bytes with an EXIF block through, even when the encoder produced them', async () => {
    const leaky = engine(() => new Blob([fakeExifJpeg()], { type: 'image/jpeg' }));
    await expect(preparePhoto(file, leaky.photoEngine)).rejects.toMatchObject({
      reason: 'metadata',
    });
  });

  test('the bytes that come out are a picture the server accepts', async () => {
    const e = engine(() => new Blob([fakeJpeg(40_000)], { type: 'image/jpeg' }));
    const photo = await preparePhoto(file, e.photoEngine);
    const info = sniffImage(new Uint8Array(await photo.arrayBuffer()));
    expect(info?.contentType).toBe('image/jpeg');
  });
});
