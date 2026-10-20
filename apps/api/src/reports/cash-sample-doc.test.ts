/**
 * `docs/p7-cash-sample.md` is what the owner checks by hand; `packages/finance/src/cash-sample.test.ts`
 * pins the same rows to the satang. This keeps the document from drifting: it must still state the
 * figures that test asserts. (The finance package is pure, so the file read lives here.)
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the receipts-payments hand-check sheet states the figures the sample test pins', () => {
  const doc = readFileSync(new URL('../../../../docs/p7-cash-sample.md', import.meta.url), 'utf8');
  for (const figure of [
    '500.00 at the start of 24 Sep',
    '685.00',
    '375.00',
    '310.00',
    '270.00',
    '105.00',
    '810.00',
    '765.00',
    '265.00',
    '510.00',
    '245.00',
    '175.00',
    '480.00',
    '705.00',
  ]) {
    expect(doc, figure).toContain(figure);
  }
});
