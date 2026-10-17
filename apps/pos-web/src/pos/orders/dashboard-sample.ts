/**
 * The one figure of the overview that is still an example: the VAT meter. Tax estimates arrive
 * with P7, so the card shows these numbers, labelled as sample data. Everything else on the page
 * comes from `/v1/reports/*`. Nothing here is read from or written to orders.
 */
export const SAMPLE_VAT = { percent: 62, limit: '฿1,800,000', year: '฿1,126,400' } as const;
