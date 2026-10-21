/**
 * A grayscale drawing surface that ends as a black and white bitmap. Dots hold "darkness"
 * (0 paper .. 1 ink); text is anti-aliased while drawing and then cut at a threshold, which is
 * what a thermal head needs (no halftones, no photos).
 */
import { type Bitmap, createBitmap } from './bitmap.ts';
import type { ShapedText } from './fonts.ts';
import { fillSegments, flattenPath, type Segment } from './rasterize.ts';

export type Ink = 'black' | 'white';

/** A dot becomes black when it is at least this dark. Below 0.5 keeps thin tone marks alive. */
export const DEFAULT_THRESHOLD = 0.42;

export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly dark: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.dark = new Float32Array(width * height);
  }

  private blend(x: number, y: number, amount: number, ink: Ink): void {
    const index = y * this.width + x;
    const old = this.dark[index] ?? 0;
    this.dark[index] = ink === 'black' ? old + (1 - old) * amount : old * (1 - amount);
  }

  fillRect(x: number, y: number, width: number, height: number, ink: Ink = 'black'): void {
    const x0 = Math.max(0, Math.round(x));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y0 = Math.max(0, Math.round(y));
    const y1 = Math.min(this.height, Math.round(y + height));
    for (let row = y0; row < y1; row++)
      for (let col = x0; col < x1; col++) this.blend(col, row, 1, ink);
  }

  /** A one-dot frame inside the rectangle, `thickness` dots wide. */
  strokeRect(x: number, y: number, width: number, height: number, thickness = 2): void {
    this.fillRect(x, y, width, thickness);
    this.fillRect(x, y + height - thickness, width, thickness);
    this.fillRect(x, y, thickness, height);
    this.fillRect(x + width - thickness, y, thickness, height);
  }

  /** A dashed horizontal rule. */
  dashedLine(x: number, y: number, width: number, thickness = 2, dash = 8, gap = 6): void {
    for (let at = 0; at < width; at += dash + gap) {
      this.fillRect(x + at, y, Math.min(dash, width - at), thickness);
    }
  }

  /** Draws shaped text with its baseline at `baselineY` and its left edge at `x`. */
  drawText(shaped: ShapedText, x: number, baselineY: number, ink: Ink = 'black'): void {
    const segments: Segment[] = [];
    for (const glyph of shaped.glyphs) {
      flattenPath(glyph.path, glyph.scale, x + glyph.x, baselineY - glyph.y, segments);
    }
    const coverage = fillSegments(segments, this.width, this.height);
    if (!coverage) return;
    for (let row = 0; row < coverage.height; row++) {
      for (let col = 0; col < coverage.width; col++) {
        const amount = coverage.data[row * coverage.width + col] ?? 0;
        if (amount > 0) this.blend(coverage.x + col, coverage.y + row, amount, ink);
      }
    }
  }

  toBitmap(threshold = DEFAULT_THRESHOLD): Bitmap {
    const bitmap = createBitmap(this.width, this.height);
    for (let i = 0; i < this.dark.length; i++)
      bitmap.data[i] = (this.dark[i] ?? 0) >= threshold ? 1 : 0;
    return bitmap;
  }
}
