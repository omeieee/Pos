/**
 * Draws a QR code on the device, with no network: the text becomes a grid of dark and light
 * modules, and the grid becomes one SVG path. Pure; the screen puts the path in an `<svg>`.
 *
 * Same settings as the server's picture (apps/api/src/payments/qr.ts): error correction M and a
 * quiet zone of 4 modules. The payload is plain ASCII made of digits and capitals, so the smaller
 * alphanumeric mode is used when the text allows it and the byte mode otherwise.
 *
 * The text is the PromptPay payload and holds the real ID: nothing here keeps it, logs it or puts it
 * in an error. A failure says only that a QR could not be made.
 */
import qrcode from 'qrcode-generator';

/** The quiet zone of the QR specification, in modules. */
export const QUIET_ZONE = 4;

const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;

export interface QrPath {
  /** Width and height of the viewBox, in modules, quiet zone included. */
  size: number;
  /** One path: every dark module, merged into runs along its row. */
  d: string;
}

export function qrGrid(text: string): boolean[][] {
  const code = qrcode(0, 'M');
  code.addData(text, ALPHANUMERIC.test(text) ? 'Alphanumeric' : 'Byte');
  code.make();
  const count = code.getModuleCount();
  const grid: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const cells: boolean[] = [];
    for (let col = 0; col < count; col += 1) cells.push(code.isDark(row, col));
    grid.push(cells);
  }
  return grid;
}

export function qrPath(text: string): QrPath {
  const grid = qrGrid(text);
  const parts: string[] = [];
  grid.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      let end = col;
      while (end < cells.length && cells[end]) end += 1;
      parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${end - col}v1h-${end - col}z`);
      col = end;
    }
  });
  return { size: grid.length + 2 * QUIET_ZONE, d: parts.join('') };
}
