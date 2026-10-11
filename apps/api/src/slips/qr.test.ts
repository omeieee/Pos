/**
 * Reading the small QR on a slip picture (D-26), end to end with REAL pictures: a QR is drawn into
 * a phone-sized white page, saved as PNG or JPEG and read back through the same code the server
 * runs (directly, and through the worker thread).
 */
import { crc16Ccitt } from '@sds/shared';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { describe, expect, test } from 'vitest';
import { createWorkerQrReader } from './qr.ts';
import { readSlipQr } from './qr-decode.ts';

const tlv = (tag: string, value: string) =>
  `${tag}${String(value.length).padStart(2, '0')}${value}`;
const REF = '016285143033BTF01234';
const body = `${tlv('00', tlv('00', '000001') + tlv('01', '014') + tlv('02', REF))}${tlv('51', 'TH')}9104`;
const SLIP_QR_TEXT = `${body}${crc16Ccitt(body)}`;
const EXPECTED = { sendingBank: '014', transRef: REF };

interface Page {
  width: number;
  height: number;
  data: Buffer;
}

/** A white page with the QR of `text` drawn at (left, top), `scale` pixels per module. */
function page(
  text: string,
  { width = 1170, height = 2532, left = 800, top = 2100, scale = 4, dark = 0 } = {},
): Page {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = Buffer.alloc(width * height * 4, 255);
  const quiet = 4 * scale;
  // Quiet zone is the white of the page; draw the dark modules only.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = ((top + quiet + y * scale + dy) * width + (left + quiet + x * scale + dx)) * 4;
          data[at] = dark;
          data[at + 1] = dark;
          data[at + 2] = dark;
        }
      }
    }
  }
  return { width, height, data };
}

const png = (p: Page) =>
  PNG.sync.write(Object.assign(new PNG({ width: p.width, height: p.height }), { data: p.data }));
const jpg = (p: Page) =>
  Buffer.from(jpeg.encode({ width: p.width, height: p.height, data: p.data }, 85).data);

describe('readSlipQr', () => {
  test('reads a slip QR from a PNG', () => {
    expect(readSlipQr(png(page(SLIP_QR_TEXT)))).toEqual(EXPECTED);
  });

  test('reads a slip QR from a JPEG (a re-compressed photo of the screen)', () => {
    expect(readSlipQr(jpg(page(SLIP_QR_TEXT)))).toEqual(EXPECTED);
  });

  test('finds a small QR in a big page by looking at a crop at full resolution', () => {
    // 4000 x 3000 (a 12 MP phone photo): the whole page is shrunk, the lower right is not.
    const photo = page(SLIP_QR_TEXT, {
      width: 4000,
      height: 3000,
      left: 2900,
      top: 2000,
      scale: 5,
    });
    expect(readSlipQr(png(photo))).toEqual(EXPECTED);
  });

  test('a picture with no QR gives null', () => {
    const blank = { width: 600, height: 800, data: Buffer.alloc(600 * 800 * 4, 255) };
    expect(readSlipQr(png(blank))).toBeNull();
  });

  test('a QR that is not a slip QR gives null', () => {
    expect(readSlipQr(png(page('https://example.com/pay?id=1234567890')))).toBeNull();
    expect(
      readSlipQr(png(page('00020101021129370016A000000677010111011300668123456785802TH6304ABCD'))),
    ).toBeNull();
  });

  test('a slip QR whose CRC does not match is not used', () => {
    const wrong = `${SLIP_QR_TEXT.slice(0, -4)}0000`;
    expect(readSlipQr(png(page(wrong)))).toBeNull();
  });

  test('anything that is not a readable picture gives null, never throws', () => {
    expect(readSlipQr(Buffer.from('not a picture at all'))).toBeNull();
    expect(
      readSlipQr(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 7)])),
    ).toBeNull();
    expect(readSlipQr(png(page(SLIP_QR_TEXT)).subarray(0, 200))).toBeNull();
  });

  test('a WebP picture is not read (no decoder): null', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(40),
    ]);
    expect(readSlipQr(webp)).toBeNull();
  });

  test('stops when the time budget is spent', () => {
    expect(readSlipQr(png(page(SLIP_QR_TEXT)), -1)).toBeNull();
  });
});

describe('createWorkerQrReader', () => {
  test('reads the QR in a worker thread and answers with the parsed values only', async () => {
    const reader = createWorkerQrReader();
    const found = await reader.read(png(page(SLIP_QR_TEXT)));
    expect(found).toEqual(EXPECTED);
    expect(JSON.stringify(found)).not.toContain(SLIP_QR_TEXT);
  }, 30_000);

  test('a picture without a QR gives null', async () => {
    const reader = createWorkerQrReader();
    expect(await reader.read(Buffer.from('nothing here'))).toBeNull();
  }, 30_000);

  test('a worker that takes too long is stopped at the hard timeout', async () => {
    const reader = createWorkerQrReader({ timeoutMs: 1 });
    await expect(reader.read(png(page(SLIP_QR_TEXT)))).rejects.toThrow('QR_TIMEOUT');
  }, 30_000);
});
