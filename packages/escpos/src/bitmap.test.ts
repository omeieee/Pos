import { describe, expect, it } from 'vitest';
import {
  type Bitmap,
  createBitmap,
  encodeRaster,
  isCoverOpenStatus,
  isOfflineStatus,
  isPaperEndStatus,
} from './bitmap.ts';

const fromRows = (rows: string[]): Bitmap => {
  const bitmap = createBitmap(rows[0]?.length ?? 0, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) bitmap.data[y * bitmap.width + x] = row[x] === '#' ? 1 : 0;
  });
  return bitmap;
};

describe('encodeRaster', () => {
  it('encodes an 8x2 bitmap as one GS v 0 block, MSB leftmost', () => {
    const bytes = encodeRaster(fromRows(['#.......', '.......#']));
    expect([...bytes]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0x80, 0x01]);
  });

  it('pads a width that is not a multiple of 8 with paper on the right', () => {
    const bytes = encodeRaster(fromRows(['#######..#', '.#........']));
    // width 10 -> 2 bytes per row
    expect([...bytes]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0, 0xfe, 0x40, 0x40, 0x00]);
  });

  it('writes the width in bytes and the height in dots little-endian', () => {
    const bytes = encodeRaster(createBitmap(576, 300), 1000);
    expect([...bytes.slice(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 300 & 0xff, 300 >> 8]);
    expect(bytes.length).toBe(8 + 72 * 300);
  });

  it('splits a tall bitmap into bands that cover every row once', () => {
    const bitmap = createBitmap(8, 5);
    bitmap.data[0] = 1; // first row
    bitmap.data[4 * 8 + 7] = 1; // last row
    const bytes = encodeRaster(bitmap, 2);
    expect([...bytes]).toEqual([
      ...[0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0x80, 0x00],
      ...[0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0x00, 0x00],
      ...[0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0, 0x01],
    ]);
  });

  it('rejects data that does not match the size and bad band heights', () => {
    expect(() => encodeRaster({ width: 8, height: 2, data: new Uint8Array(3) })).toThrow(
      RangeError,
    );
    expect(() => encodeRaster(createBitmap(8, 2), 0)).toThrow(RangeError);
  });
});

describe('status bytes', () => {
  it('reads the documented bits', () => {
    expect(isOfflineStatus(0x08)).toBe(true);
    expect(isOfflineStatus(0x12)).toBe(false);
    expect(isCoverOpenStatus(0x04)).toBe(true);
    expect(isPaperEndStatus(0x60)).toBe(true);
    expect(isPaperEndStatus(0x00)).toBe(false);
  });
});
