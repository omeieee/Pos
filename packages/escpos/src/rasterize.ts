/**
 * A small anti-aliased filler for glyph outlines, so no canvas or native module is needed.
 * Outlines are flattened to line segments and filled with the non-zero rule at 4 sub-scanlines
 * per dot row and exact coverage along each row.
 */

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type PathCommand =
  | { command: 'moveTo'; args: [number, number] }
  | { command: 'lineTo'; args: [number, number] }
  | { command: 'quadraticCurveTo'; args: [number, number, number, number] }
  | { command: 'bezierCurveTo'; args: [number, number, number, number, number, number] }
  | { command: 'closePath'; args: [] };

const CURVE_STEPS = 8;
const SUBROWS = 4;

/**
 * Flattens a font path into segments, mapping font units to dots: x' = ox + x*scale,
 * y' = oy - y*scale (font y points up, dots go down).
 */
export function flattenPath(
  commands: readonly PathCommand[],
  scale: number,
  ox: number,
  oy: number,
  out: Segment[],
): void {
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy - y * scale;
  const line = (x: number, y: number) => {
    out.push({ x0: curX, y0: curY, x1: x, y1: y });
    curX = x;
    curY = y;
  };
  const closeContour = () => {
    if (curX !== startX || curY !== startY) line(startX, startY);
  };
  for (const cmd of commands) {
    switch (cmd.command) {
      case 'moveTo':
        closeContour();
        curX = startX = px(cmd.args[0]);
        curY = startY = py(cmd.args[1]);
        break;
      case 'lineTo':
        line(px(cmd.args[0]), py(cmd.args[1]));
        break;
      case 'quadraticCurveTo': {
        const x0 = curX;
        const y0 = curY;
        const cx = px(cmd.args[0]);
        const cy = py(cmd.args[1]);
        const x1 = px(cmd.args[2]);
        const y1 = py(cmd.args[3]);
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          line(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
        }
        break;
      }
      case 'bezierCurveTo': {
        const x0 = curX;
        const y0 = curY;
        const c1x = px(cmd.args[0]);
        const c1y = py(cmd.args[1]);
        const c2x = px(cmd.args[2]);
        const c2y = py(cmd.args[3]);
        const x1 = px(cmd.args[4]);
        const y1 = py(cmd.args[5]);
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          line(
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1,
          );
        }
        break;
      }
      case 'closePath':
        closeContour();
        break;
    }
  }
  closeContour();
}

export interface Coverage {
  /** Left and top edge of the buffer in dots, already clipped to the canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 per dot, row by row. */
  data: Float32Array;
}

/** Fills the segments (non-zero winding) and returns per-dot coverage, clipped to the area. */
export function fillSegments(
  segments: readonly Segment[],
  clipWidth: number,
  clipHeight: number,
): Coverage | null {
  if (segments.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of segments) {
    minX = Math.min(minX, s.x0, s.x1);
    maxX = Math.max(maxX, s.x0, s.x1);
    minY = Math.min(minY, s.y0, s.y1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  const left = Math.max(0, Math.floor(minX));
  const right = Math.min(clipWidth, Math.ceil(maxX));
  const top = Math.max(0, Math.floor(minY));
  const bottom = Math.min(clipHeight, Math.ceil(maxY));
  if (right <= left || bottom <= top) return null;

  const width = right - left;
  const height = bottom - top;
  const data = new Float32Array(width * height);
  const crossings: Array<{ x: number; dir: number }> = [];

  for (let row = 0; row < height; row++) {
    for (let sub = 0; sub < SUBROWS; sub++) {
      const y = top + row + (sub + 0.5) / SUBROWS;
      crossings.length = 0;
      for (const s of segments) {
        if (s.y0 === s.y1) continue;
        const down = s.y0 < s.y1;
        const yLow = down ? s.y0 : s.y1;
        const yHigh = down ? s.y1 : s.y0;
        if (y < yLow || y >= yHigh) continue;
        const x = s.x0 + ((y - s.y0) / (s.y1 - s.y0)) * (s.x1 - s.x0);
        crossings.push({ x, dir: down ? 1 : -1 });
      }
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        const here = crossings[i];
        const next = crossings[i + 1];
        if (!here || !next) break;
        winding += here.dir;
        if (winding !== 0) addSpan(data, row * width, left, width, here.x, next.x);
      }
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, (data[i] ?? 0) / SUBROWS);
  return { x: left, y: top, width, height, data };
}

/** Adds the exact horizontal overlap of [x0, x1) with each dot of one sub-scanline. */
function addSpan(
  data: Float32Array,
  rowOffset: number,
  left: number,
  width: number,
  x0: number,
  x1: number,
): void {
  const a = Math.max(x0 - left, 0);
  const b = Math.min(x1 - left, width);
  if (b <= a) return;
  const first = Math.floor(a);
  const last = Math.min(Math.ceil(b) - 1, width - 1);
  for (let px = first; px <= last; px++) {
    const overlap = Math.min(b, px + 1) - Math.max(a, px);
    const index = rowOffset + px;
    data[index] = (data[index] ?? 0) + overlap;
  }
}
