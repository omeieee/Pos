import { describe, expect, test } from 'vitest';
import { imageSize } from './image.ts';

const png = (width: number, height: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

/** SOI, an APP0 segment, then SOF0 with the size. */
const jpeg = (width: number, height: number) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
};

const webpHeader = (kind: string, size: number) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  b.writeUInt32LE(size, 16);
  return b;
};

describe('imageSize', () => {
  test('PNG', () => {
    expect(imageSize(png(1170, 2532))).toEqual({ width: 1170, height: 2532 });
  });

  test('JPEG, past another segment', () => {
    expect(imageSize(jpeg(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });

  test('WebP: extended, lossy and lossless', () => {
    const x = webpHeader('VP8X', 10);
    x.writeUIntLE(1079, 24, 3);
    x.writeUIntLE(1919, 27, 3);
    expect(imageSize(x)).toEqual({ width: 1080, height: 1920 });

    const lossy = webpHeader('VP8 ', 10);
    lossy.writeUInt16LE(720, 26);
    lossy.writeUInt16LE(1280, 28);
    expect(imageSize(lossy)).toEqual({ width: 720, height: 1280 });

    const lossless = webpHeader('VP8L', 10);
    lossless.writeUInt32LE(719 | (1279 << 14), 21);
    expect(imageSize(lossless)).toEqual({ width: 720, height: 1280 });
  });

  test('a header that is not understood is null', () => {
    expect(imageSize(Buffer.from('not a picture at all'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
