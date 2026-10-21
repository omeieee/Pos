/**
 * Line breaking for text with no spaces between words (Thai): break at word boundaries from the
 * ICU dictionary, and inside a word only when a single word is wider than the line.
 */
import { measureText } from './fonts.ts';

const wordSegmenter = new Intl.Segmenter('th', { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });

export function wrapText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    wrapParagraph(paragraph, size, bold, maxWidth, lines);
  }
  return lines.length > 0 ? lines : [''];
}

function wrapParagraph(
  paragraph: string,
  size: number,
  bold: boolean,
  maxWidth: number,
  lines: string[],
): void {
  const fits = (candidate: string) => measureText(candidate, size, bold) <= maxWidth;
  let line = '';
  const flush = () => {
    const trimmed = line.trimEnd();
    if (trimmed !== '') lines.push(trimmed);
    line = '';
  };

  for (const { segment } of wordSegmenter.segment(paragraph)) {
    if (fits(line + segment)) {
      line += segment;
      continue;
    }
    flush();
    const word = segment.trimStart();
    if (fits(word)) {
      line = word;
      continue;
    }
    // A single word wider than the line: break it between grapheme clusters, never inside one,
    // so a vowel or tone mark is never separated from its consonant.
    for (const { segment: cluster } of graphemeSegmenter.segment(word)) {
      if (!fits(line + cluster) && line !== '') flush();
      line += cluster;
    }
  }
  flush();
}
