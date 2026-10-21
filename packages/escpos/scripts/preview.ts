/**
 * Manual check, not part of the tests: draws the sample ticket (and a reprint, and a narrow one)
 * to PNG files so a person can look at the Thai. Nothing is written inside the repository.
 *   pnpm --filter @sds/escpos preview <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { SAMPLE_TICKET, ticketBitmap } from '../src/index.ts';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: preview <out-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const cases = [
  ['ticket-576', { ...SAMPLE_TICKET }, 576],
  ['ticket-576-reprint', { ...SAMPLE_TICKET, reprint: true, copy: 2, channel: 'lineman' }, 576],
  ['ticket-384', { ...SAMPLE_TICKET }, 384],
] as const;

for (const [name, ticket, width] of cases) {
  const bitmap = ticketBitmap(ticket, { widthDots: width });
  const png = new PNG({ width: bitmap.width, height: bitmap.height });
  bitmap.data.forEach((dot, i) => {
    const v = dot ? 0 : 255;
    png.data.set([v, v, v, 255], i * 4);
  });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, PNG.sync.write(png));
  console.log(`${file} ${bitmap.width}x${bitmap.height}`);
}
