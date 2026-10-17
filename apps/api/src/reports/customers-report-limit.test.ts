/**
 * GET /v1/reports/customers sends at most CUSTOMERS_LISTED rows (the most recent first), so the
 * owner's screen never pulls the whole customer book (PDPA: no bulk personal data the screen does
 * not show), while the segment counts still cover every customer.
 */
import { schema } from '@sds/db';
import { CUSTOMERS_LISTED, customersReportSchema } from '@sds/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

test('lists the most recent customers up to the limit, and counts all of them in the summary', async () => {
  const extra = 7;
  const total = CUSTOMERS_LISTED + extra;
  const DAY = 86_400_000;
  await h.db.insert(schema.customers).values(
    Array.from({ length: total }, (_, i) => ({
      displayName: `C${String(i).padStart(3, '0')}`,
      firstSeenAt: new Date(Date.now() - 100 * DAY),
      // C000 is the most recent, then older and older
      lastOrderAt: new Date(Date.now() - (i + 1) * 60_000),
    })),
  );
  const token = await h.ownerSession(await h.newOwner());
  const res = await h.app.inject({
    method: 'GET',
    url: '/v1/reports/customers',
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: h.nextIp(),
  });
  expect(res.statusCode).toBe(200);
  const body = customersReportSchema.parse(res.json());
  expect(body.customers).toHaveLength(CUSTOMERS_LISTED);
  expect(body.customers[0]?.name).toBe('C000');
  expect(body.customers.at(-1)?.name).toBe(`C${String(CUSTOMERS_LISTED - 1).padStart(3, '0')}`);
  // every customer is counted in the segments, listed or not
  expect(body.summary.new + body.summary.regular + body.summary.lapsed).toBe(total);
});
