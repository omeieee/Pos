/**
 * Thai shaping and measuring. Sarabun (SIL OFL 1.1, bundled as base64) is read by fontkit, which
 * applies the font's own GSUB/GPOS rules, so above and below vowels and tone marks sit where the
 * type designer put them. A font file holds either Thai or Latin glyphs here (they are separate
 * subsets), so text is cut into runs by script and each run is shaped with its own font.
 */
import * as fontkit from 'fontkit';
import {
  latinBoldBase64,
  latinRegularBase64,
  thaiBoldBase64,
  thaiRegularBase64,
} from './fonts.generated.ts';
import type { PathCommand } from './rasterize.ts';

export interface PositionedGlyph {
  /** Pen position of the glyph origin, in dots, from the start of the run. */
  x: number;
  /** Vertical shift in dots (up is positive), for stacked marks. */
  y: number;
  /** Dots per font unit for this glyph's font. */
  scale: number;
  path: readonly PathCommand[];
}

export interface ShapedText {
  glyphs: PositionedGlyph[];
  /** Total advance in dots. */
  width: number;
}

export interface FontMetrics {
  /** Distance from the baseline up to the top of a line, in em. */
  ascent: number;
  /** Distance from the baseline down to the bottom of a line, in em. */
  descent: number;
}

type Script = 'thai' | 'latin';
type Face = { thai: fontkit.Font; latin: fontkit.Font };

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const load = (base64: string): fontkit.Font => {
  const font = fontkit.create(decode(base64) as unknown as Buffer);
  if (!('layout' in font)) throw new Error('Embedded font is a collection');
  return font;
};

let faces: { regular: Face; bold: Face } | undefined;
const getFaces = () => {
  faces ??= {
    regular: { thai: load(thaiRegularBase64), latin: load(latinRegularBase64) },
    bold: { thai: load(thaiBoldBase64), latin: load(latinBoldBase64) },
  };
  return faces;
};

const scriptOf = (char: string): Script => {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x0e00 && code <= 0x0e7f ? 'thai' : 'latin';
};

/** Splits text into runs of one script. Marks and joiners stay with the character before them. */
function splitRuns(text: string): Array<{ script: Script; text: string }> {
  const runs: Array<{ script: Script; text: string }> = [];
  for (const char of text) {
    const script = scriptOf(char);
    const last = runs[runs.length - 1];
    if (last && last.script === script) last.text += char;
    else runs.push({ script, text: char });
  }
  return runs;
}

/** Line metrics of the two bundled faces (Sarabun: ascent 1.068 em, descent 0.232 em). */
export function fontMetrics(): FontMetrics {
  const font = getFaces().regular.thai;
  return { ascent: font.ascent / font.unitsPerEm, descent: -font.descent / font.unitsPerEm };
}

/** Shapes one line of text at `size` dots per em. Characters the font lacks are skipped. */
export function shapeText(text: string, size: number, bold: boolean): ShapedText {
  const face = bold ? getFaces().bold : getFaces().regular;
  const glyphs: PositionedGlyph[] = [];
  let pen = 0;
  for (const run of splitRuns(text)) {
    const font = face[run.script];
    const scale = size / font.unitsPerEm;
    const layout = font.layout(run.text);
    layout.glyphs.forEach((glyph, index) => {
      const position = layout.positions[index];
      if (!position) return;
      if (glyph.id !== 0) {
        glyphs.push({
          x: pen + position.xOffset * scale,
          y: position.yOffset * scale,
          scale,
          path: glyph.path.commands as unknown as readonly PathCommand[],
        });
      }
      pen += position.xAdvance * scale;
    });
  }
  return { glyphs, width: pen };
}

export const measureText = (text: string, size: number, bold: boolean): number =>
  shapeText(text, size, bold).width;
