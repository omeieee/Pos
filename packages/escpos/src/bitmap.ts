/**
 * Monochrome bitmaps and the ESC/POS bytes that carry them. Pure: bytes in, bytes out.
 */

/** One entry per dot: 1 = black (printed), 0 = paper. */
export interface Bitmap {
  width: number;
  height: number;
  /** `width * height` entries, row by row, each 0 or 1. */
  data: Uint8Array;
}

export const ESC = 0x1b;
export const GS = 0x1d;

/** ESC @ : reset the printer to its defaults. */
export const INIT_PRINTER = Uint8Array.of(ESC, 0x40);
/** GS V 66 0 : feed the paper to the cutting position and cut (partial cut). */
export const FEED_AND_CUT = Uint8Array.of(GS, 0x56, 0x42, 0x00);

/** Tall images are sent in bands: some firmware drops a single very tall raster block. */
export const DEFAULT_BAND_HEIGHT = 256;

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height) };
}

/**
 * Encodes a bitmap as one or more `GS v 0` raster blocks (normal density, mode 0):
 * `1D 76 30 m xL xH yL yH d1...dk`, where x is the width in BYTES and y the height in dots, and
 * each data byte holds 8 dots with the most significant bit leftmost. A width that is not a
 * multiple of 8 is padded with paper on the right.
 */
export function encodeRaster(bitmap: Bitmap, bandHeight = DEFAULT_BAND_HEIGHT): Uint8Array {
  if (!Number.isInteger(bandHeight) || bandHeight < 1 || bandHeight > 65535) {
    throw new RangeError('bandHeight must be an integer between 1 and 65535');
  }
  const { width, height, data } = bitmap;
  if (data.length !== width * height) throw new RangeError('bitmap data does not match its size');
  const widthBytes = Math.ceil(width / 8);
  if (widthBytes < 1 || widthBytes > 65535) throw new RangeError('bitmap width out of range');

  const parts: Uint8Array[] = [];
  for (let top = 0; top < height; top += bandHeight) {
    const rows = Math.min(bandHeight, height - top);
    const block = new Uint8Array(8 + widthBytes * rows);
    block.set([GS, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, rows & 0xff, rows >> 8]);
    for (let row = 0; row < rows; row++) {
      const rowStart = (top + row) * width;
      const out = 8 + row * widthBytes;
      for (let x = 0; x < width; x++) {
        if (data[rowStart + x]) {
          const index = out + (x >> 3);
          block[index] = (block[index] ?? 0) | (0x80 >> (x & 7));
        }
      }
    }
    parts.push(block);
  }
  return concatBytes(parts);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------- Real-time status (optional; not verified on a real XP-80T, see the agent README) ----------

/** DLE EOT n : ask for one status byte. n = 1 printer, 2 offline cause, 4 paper sensor. */
export const statusQuery = (n: 1 | 2 | 4): Uint8Array => Uint8Array.of(0x10, 0x04, n);

/** Reads the reply to `statusQuery(1)`: bit 3 set means the printer is offline. */
export const isOfflineStatus = (byte: number): boolean => (byte & 0x08) !== 0;
/** Reads the reply to `statusQuery(2)`: bit 2 set means the cover is open. */
export const isCoverOpenStatus = (byte: number): boolean => (byte & 0x04) !== 0;
/** Reads the reply to `statusQuery(4)`: bits 5 and 6 set mean the roll has run out. */
export const isPaperEndStatus = (byte: number): boolean => (byte & 0x60) !== 0;
