import { promptpayPayload } from '@sds/promptpay';
import { satang } from '@sds/shared';
import jsQR from 'jsqr';
import { describe, expect, test } from 'vitest';
import { QUIET_ZONE, qrGrid, qrPath } from './local-qr.ts';

const SCALE = 6;

/** The grid as a picture a scanner would see: black on white, with the quiet zone. */
function picture(grid: boolean[][]) {
  const side = (grid.length + 2 * QUIET_ZONE) * SCALE;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  grid.forEach((cells, row) => {
    cells.forEach((dark, col) => {
      if (!dark) return;
      for (let y = 0; y < SCALE; y += 1) {
        for (let x = 0; x < SCALE; x += 1) {
          const px = (col + QUIET_ZONE) * SCALE + x;
          const py = (row + QUIET_ZONE) * SCALE + y;
          const at = (py * side + px) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
        }
      }
    });
  });
  return { data, side };
}

const TARGETS = [
  { idType: 'phone', idValue: '0812345678' },
  { idType: 'national_id', idValue: '1234567890123' },
  { idType: 'ewallet', idValue: '123456789012345' },
] as const;

describe('the QR drawn on the device', () => {
  test.each(TARGETS)('a scanner reads back the exact payload ($idType)', (target) => {
    for (const amount of [100, 7500, 12345, 99_999_999]) {
      const payload = promptpayPayload(target, satang(amount));
      const { data, side } = picture(qrGrid(payload));
      const found = jsQR(data, side, side);
      expect(found?.data).toBe(payload);
    }
  });

  test('the path draws exactly the modules of the grid, quiet zone included', () => {
    const payload = promptpayPayload(TARGETS[0], satang(7500));
    const grid = qrGrid(payload);
    const { size, d } = qrPath(payload);
    expect(size).toBe(grid.length + 2 * QUIET_ZONE);
    const drawn = grid.map((cells) => cells.map(() => false));
    for (const run of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, length] = [Number(run[1]), Number(run[2]), Number(run[3])];
      for (let i = 0; i < length; i += 1) {
        const cells = drawn[y - QUIET_ZONE];
        if (cells) cells[x - QUIET_ZONE + i] = true;
      }
    }
    expect(drawn).toEqual(grid);
  });

  test('text outside the alphanumeric set still draws (byte mode)', () => {
    const { data, side } = picture(qrGrid('abc def 123'));
    expect(jsQR(data, side, side)?.data).toBe('abc def 123');
  });
});
