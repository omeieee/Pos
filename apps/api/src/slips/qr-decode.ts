import { parseSlipQr, type SlipQr } from '@sds/shared';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { sniffSlip } from './image.ts';

/**
 * Finds the small "slip verify" QR on a transfer slip picture and reads it (D-26), all in this
 * process with pure JavaScript (jsQR plus jpeg-js / pngjs): no native module, no cloud service,
 * the picture never leaves the machine. It runs INSIDE a worker thread (`qr.ts`), because decoding
 * is CPU work that would otherwise stop the API on the small shop server.
 *
 * Only what the parser accepts is returned: the sending bank and the reference, and for the bank
 * check (D-27) the raw text of that same slip QR (`readSlipQrText`). The raw text is for memory
 * only: it is sent to Slip2Go and never stored, logged or put in an answer. A QR the parser does
 * not accept (a PromptPay QR, a link, a bad CRC) is never returned. JPEG and PNG are read; WebP is
 * not (no small pure JavaScript decoder), so a WebP slip simply has no QR reading.
 */

/** A picture as plain RGBA pixels. */
interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A part of the picture, as fractions of its width and height. */
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where to look, cheapest and most likely first: the whole slip, its lower half, the lower right
 * and the centre. The mini QR is small, so a crop is read at full resolution where the whole
 * picture would be shrunk too much.
 */
const REGIONS: readonly Region[] = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0.5, w: 1, h: 0.5 },
  { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
];

/** One jsQR call works on at most this many pixels; larger regions are shrunk first. */
export const MAX_ATTEMPT_PIXELS = 3_000_000;
/** The decoders refuse a picture beyond this (the API checks the header size first). */
const MAX_DECODE_MEGAPIXELS = 16;
const MAX_DECODE_MEMORY_MB = 256;

function toRaster(bytes: Uint8Array): Raster | null {
  switch (sniffSlip(bytes)) {
    case 'image/png': {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
    }
    case 'image/jpeg': {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_DECODE_MEGAPIXELS,
        maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
      });
      return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    }
    default:
      return null;
  }
}

/** The region cut out, and shrunk by whole-pixel averaging until it fits MAX_ATTEMPT_PIXELS. */
function cut(source: Raster, region: Region): Raster {
  const x0 = Math.floor(source.width * region.x);
  const y0 = Math.floor(source.height * region.y);
  const w = Math.max(1, Math.min(source.width - x0, Math.floor(source.width * region.w)));
  const h = Math.max(1, Math.min(source.height - y0, Math.floor(source.height * region.h)));
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_ATTEMPT_PIXELS)));
  const outW = Math.max(1, Math.floor(w / step));
  const outH = Math.max(1, Math.floor(h / step));
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const at = ((y0 + y * step + dy) * source.width + (x0 + x * step + dx)) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (source.data[at + c] ?? 0);
        }
      }
      const out = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) data[out + c] = (sum[c] ?? 0) / (step * step);
    }
  }
  return { width: outW, height: outH, data };
}

/** A slip QR as parsed, with the exact text it was read from (memory only, see above). */
export interface SlipQrText {
  qr: SlipQr;
  raw: string;
}

/**
 * The slip QR on the picture, or null when there is none, it cannot be read, or it is not a slip
 * QR (a CRC that does not match counts as unreadable). Tries the regions in turn and stops at the
 * first slip QR; the time `budgetMs` is checked between tries. Never throws for a bad picture.
 */
export function readSlipQr(bytes: Uint8Array, budgetMs = 15_000): SlipQr | null {
  return readSlipQrText(bytes, budgetMs)?.qr ?? null;
}

/** Like `readSlipQr`, and the raw text of the QR as well. */
export function readSlipQrText(bytes: Uint8Array, budgetMs = 15_000): SlipQrText | null {
  const until = Date.now() + budgetMs;
  let raster: Raster | null;
  try {
    raster = toRaster(bytes);
  } catch {
    return null;
  }
  if (!raster) return null;
  for (const region of REGIONS) {
    if (Date.now() > until) return null;
    const part = cut(raster, region);
    const found = jsQR(part.data, part.width, part.height, { inversionAttempts: 'dontInvert' });
    const parsed = found ? parseSlipQr(found.data) : null;
    if (parsed && found) return { qr: parsed, raw: found.data };
  }
  return null;
}
