import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { imageSize, sniffSlip } from '../slips/image.ts';

/**
 * Receipt photo preparation (D-36). Every receipt is decoded and stored again as a JPEG whose
 * longest side is at most 1280 px, aimed at about 200 KB, with EXIF removed (the orientation is
 * applied first, so a phone photo is not left on its side; the GPS position goes with the rest).
 * Pure JavaScript on purpose (`jpeg-js`, `pngjs`, already in the bundle): the runtime image holds
 * only the esbuild bundle, so a native library such as sharp would not be there. WebP is refused:
 * no pure decoder is bundled, and the phone's file picker hands over JPEG or PNG.
 */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
/** A 24 megapixel phone photo is 24.5 million; more than this is not decoded on a 1 GB server. */
export const MAX_RECEIPT_PIXELS = 26_000_000;
export const RECEIPT_LONG_SIDE = 1280;
export const RECEIPT_TARGET_BYTES = 200 * 1024;
const QUALITIES = [80, 70, 60, 50, 40];

export type ReceiptImageErrorCode = 'unsupported' | 'too_large' | 'undecodable';

export class ReceiptImageError extends Error {
  constructor(readonly code: ReceiptImageErrorCode) {
    super(`receipt image refused: ${code}`);
    this.name = 'ReceiptImageError';
  }
}

export interface PreparedReceipt {
  bytes: Buffer;
  width: number;
  height: number;
}

interface Raster {
  data: Uint8Array;
  width: number;
  height: number;
}

// One picture at a time: a decoded 24 MP photo is ~100 MB, and the server has 1 GB.
let turn: Promise<unknown> = Promise.resolve();

export function prepareReceiptImage(input: Buffer): Promise<PreparedReceipt> {
  const run = turn.then(() => prepare(input));
  turn = run.catch(() => undefined);
  return run;
}

function prepare(input: Buffer): PreparedReceipt {
  const kind = sniffSlip(input);
  if (kind !== 'image/jpeg' && kind !== 'image/png') throw new ReceiptImageError('unsupported');
  const size = imageSize(input);
  if (!size || size.width < 1 || size.height < 1) throw new ReceiptImageError('undecodable');
  if (size.width * size.height > MAX_RECEIPT_PIXELS) throw new ReceiptImageError('too_large');

  let source: Raster;
  try {
    source =
      kind === 'image/png'
        ? flattenOnWhite(PNG.sync.read(input))
        : jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 600 });
  } catch {
    throw new ReceiptImageError('undecodable');
  }
  if (source.width !== size.width || source.height !== size.height) {
    throw new ReceiptImageError('undecodable');
  }

  const scale = Math.min(1, RECEIPT_LONG_SIDE / Math.max(source.width, source.height));
  const small = scale < 1 ? shrink(source, scale) : source;
  const upright = orient(small, kind === 'image/jpeg' ? exifOrientation(input) : 1);

  let bytes = Buffer.alloc(0);
  for (const quality of QUALITIES) {
    bytes = Buffer.from(jpeg.encode({ ...upright, data: Buffer.from(upright.data) }, quality).data);
    if (bytes.length <= RECEIPT_TARGET_BYTES) break;
  }
  return { bytes, width: upright.width, height: upright.height };
}

/** Transparent areas become white, as on paper. */
function flattenOnWhite(png: PNG): Raster {
  const { data, width, height } = png;
  for (let i = 0; i < data.length; i += 4) {
    const a = (data[i + 3] as number) / 255;
    if (a === 1) continue;
    for (let c = 0; c < 3; c++)
      data[i + c] = Math.round((data[i + c] as number) * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/** Area average (every source pixel counts in proportion), which keeps small print legible. */
function shrink(src: Raster, scale: number): Raster {
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const xs = spans(src.width, width);
  const ys = spans(src.height, height);
  const out = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const [y0, y1] = ys[dy] as [number, number];
    for (let dx = 0; dx < width; dx++) {
      const [x0, x1] = xs[dx] as [number, number];
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const at = (y * src.width + x) * 4;
          r += (src.data[at] as number) * w;
          g += (src.data[at + 1] as number) * w;
          b += (src.data[at + 2] as number) * w;
          total += w;
        }
      }
      const to = (dy * width + dx) * 4;
      out[to] = Math.round(r / total);
      out[to + 1] = Math.round(g / total);
      out[to + 2] = Math.round(b / total);
      out[to + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/** The source range [from, to) each of `count` output pixels covers along an axis of `length`. */
function spans(length: number, count: number): [number, number][] {
  const step = length / count;
  return Array.from({ length: count }, (_, i): [number, number] => [
    i * step,
    Math.min(length, (i + 1) * step),
  ]);
}

/** The EXIF Orientation (1-8) of a JPEG, or 1 when there is none or it is not understood. */
export function exifOrientation(file: Uint8Array): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 2;
  while (at + 4 < file.length && file[at] === 0xff) {
    const marker = file[at + 1] as number;
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const length = view.getUint16(at + 2);
    if (
      marker === 0xe1 &&
      length >= 16 &&
      String.fromCharCode(...file.subarray(at + 4, at + 8)) === 'Exif'
    ) {
      const tiff = at + 10;
      const little = file[tiff] === 0x49;
      const u16 = (o: number) => view.getUint16(tiff + o, little);
      const u32 = (o: number) => view.getUint32(tiff + o, little);
      if (tiff + 8 > file.length || u16(2) !== 42) return 1;
      const ifd = u32(4);
      if (tiff + ifd + 2 > file.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (tiff + entry + 12 > file.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** Turns the picture the way the EXIF orientation says it is shown (1 = as stored). */
function orient(src: Raster, orientation: number): Raster {
  if (orientation === 1) return src;
  const swap = orientation >= 5;
  const width = swap ? src.height : src.width;
  const height = swap ? src.width : src.height;
  const out = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          [sx, sy] = [width - 1 - dx, dy];
          break;
        case 3:
          [sx, sy] = [width - 1 - dx, height - 1 - dy];
          break;
        case 4:
          [sx, sy] = [dx, height - 1 - dy];
          break;
        case 5:
          [sx, sy] = [dy, dx];
          break;
        case 6:
          [sx, sy] = [dy, src.height - 1 - dx];
          break;
        case 7:
          [sx, sy] = [src.width - 1 - dy, src.height - 1 - dx];
          break;
        default: // 8
          [sx, sy] = [src.width - 1 - dy, dx];
      }
      const from = (sy * src.width + sx) * 4;
      const to = (dy * width + dx) * 4;
      out[to] = src.data[from] as number;
      out[to + 1] = src.data[from + 1] as number;
      out[to + 2] = src.data[from + 2] as number;
      out[to + 3] = 255;
    }
  }
  return { data: out, width, height };
}
