import { describe, expect, test } from 'vitest';
import { REPORT_MAX_DAYS, reportRangeDays, revenueReportQuerySchema } from './reports.ts';

describe('reportRangeDays', () => {
  test('counts both ends, across month and year boundaries and a leap day', () => {
    expect(reportRangeDays('2026-10-01', '2026-10-01')).toBe(1);
    expect(reportRangeDays('2026-10-01', '2026-10-31')).toBe(31);
    expect(reportRangeDays('2026-12-31', '2027-01-01')).toBe(2);
    expect(reportRangeDays('2032-02-28', '2032-03-01')).toBe(3);
    expect(reportRangeDays('2032-01-01', '2032-12-31')).toBe(REPORT_MAX_DAYS);
  });
});

describe('revenueReportQuerySchema', () => {
  const ok = (from: string, to: string) => revenueReportQuerySchema.safeParse({ from, to }).success;
  test('accepts a single day and the longest range', () => {
    expect(ok('2026-10-01', '2026-10-01')).toBe(true);
    expect(ok('2032-01-01', '2032-12-31')).toBe(true);
  });
  test('refuses a reversed, over-long, malformed or impossible range', () => {
    expect(ok('2026-10-02', '2026-10-01')).toBe(false);
    expect(ok('2032-01-01', '2033-01-01')).toBe(false);
    expect(ok('2026-1-1', '2026-10-01')).toBe(false);
    expect(ok('2026-02-30', '2026-03-01')).toBe(false);
  });
});
