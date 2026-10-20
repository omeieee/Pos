/** Typed API client: back-office reports and the accountant's CSV files (P6). */
import {
  customersReportSchema,
  heatmapReportSchema,
  itemsReportSchema,
  pnlReportSchema,
  revenueReportQuerySchema,
  revenueReportSchema,
  taxReportQuerySchema,
  taxReportSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

/** U+FEFF, the UTF-8 byte order mark. */
const BOM = String.fromCharCode(0xfeff);

export type ReportRange = z.input<typeof revenueReportQuerySchema>;
export type ExportKind = 'revenue' | 'items';

export function makeReports({ get }: Transport) {
  const read = async <S extends z.ZodType>(path: string, schema: S, range: ReportRange) =>
    (
      await get<z.output<S>>({
        path,
        query: checked(revenueReportQuerySchema, range) as Record<string, string>,
        schema,
        session: true,
        device: 'optional',
      })
    ).data;

  return {
    /** Daily revenue (paid orders, net of refunds). `report.view`. */
    revenue: (range: ReportRange) => read('/v1/reports/revenue', revenueReportSchema, range),
    /** Units and line totals per item, best seller first. `report.view`. */
    items: (range: ReportRange) => read('/v1/reports/items', itemsReportSchema, range),
    /** Orders and revenue by weekday and Bangkok hour. `report.view`. */
    heatmap: (range: ReportRange) => read('/v1/reports/heatmap', heatmapReportSchema, range),
    /** Profit and loss for the range. Owner only (`finance.pnl`). */
    pnl: (range: ReportRange) => read('/v1/reports/pnl', pnlReportSchema, range),
    /**
     * The income tax estimate for a Buddhist Era year, annual (ภ.ง.ด.90) or half-year (ภ.ง.ด.94).
     * Owner only. A year with no rules file is 422 TAX_RULES_NOT_AVAILABLE.
     */
    tax: async (query: z.output<typeof taxReportQuerySchema>) =>
      (
        await get({
          path: '/v1/reports/tax',
          query: checked(taxReportQuerySchema, query) as unknown as Record<string, string>,
          schema: taxReportSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /** The customer list with segments and favourites. Owner only (PDPA). */
    customers: async () =>
      (
        await get({
          path: '/v1/reports/customers',
          schema: customersReportSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /**
     * A CSV file for the accountant. Owner only and a step-up call: without a fresh step-up the
     * answer is STEP_UP_REQUIRED. The text starts with a byte order mark so Excel reads Thai.
     */
    exportCsv: async (kind: ExportKind, range: ReportRange) => {
      const checkedRange = checked(revenueReportQuerySchema, range);
      const { data } = await get<string>({
        path: `/v1/reports/export/${kind}.csv`,
        query: checkedRange as Record<string, string>,
        as: 'text',
        session: true,
        device: 'optional',
      });
      // `Response.text()` drops the byte order mark; Excel needs it to read Thai as UTF-8.
      const text = data.startsWith(BOM) ? data : `${BOM}${data}`;
      return { text, filename: `${kind}-${checkedRange.from}-${checkedRange.to}.csv` };
    },
  };
}
