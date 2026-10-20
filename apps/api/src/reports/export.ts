/**
 * CSV exports for the accountant (P6, B5). The route is guarded by `data.export`, which is owner
 * only and a step-up permission; every export writes one audit row (kind, range, row count, no
 * figures). Headers are Thai, from the i18n catalog.
 */
import { type Db, insertAudit } from '@sds/db';
import { itemSales, itemsCsvRows, revenueByDay, revenueCsvRows, toCsv } from '@sds/finance';
import { th } from '@sds/i18n';
import { ORDER_CHANNELS, PAYMENT_METHODS, type RevenueReportQuery } from '@sds/shared';
import type { Principal } from '../auth/service.ts';
import { loadReportOrders } from './service.ts';

export type ExportKind = 'revenue' | 'items';

export interface CsvFile {
  filename: string;
  body: string;
}

const revenueHeaders = [
  th['report.export.date'],
  th['report.export.orders'],
  th['report.export.revenue'],
  th['report.export.avgTicket'],
  th['report.export.commission'],
  ...PAYMENT_METHODS.map((m) => th[`payment.method.${m}`]),
  ...ORDER_CHANNELS.map((c) => th[`orders.channel.${c}`]),
];

const itemHeaders = [
  th['report.export.itemName'],
  th['report.export.itemUnits'],
  th['report.export.itemRevenue'],
  th['report.export.itemShare'],
];

export async function exportCsv(
  db: Db,
  actor: Principal,
  meta: { ip: string | null },
  kind: ExportKind,
  query: RevenueReportQuery,
): Promise<CsvFile> {
  const { usable: orders, excludedOrderIds } = await loadReportOrders(db, query);
  const rows =
    kind === 'revenue'
      ? revenueCsvRows(revenueByDay(orders), revenueHeaders, th['report.export.total'])
      : itemsCsvRows(itemSales(orders), itemHeaders);
  const dataRows = rows.length - 1 - (kind === 'revenue' && rows.length > 2 ? 1 : 0);
  await insertAudit(db, {
    actorType: 'staff',
    actorId: actor.staffId,
    deviceId: actor.deviceId,
    ip: meta.ip,
    action: 'report.export',
    entity: 'report_export',
    entityId: `${kind}:${query.from}:${query.to}`,
    after: {
      kind,
      from: query.from,
      to: query.to,
      rows: dataRows,
      excludedOrders: excludedOrderIds.length,
    },
  });
  return { filename: `${kind}-${query.from}-${query.to}.csv`, body: toCsv(rows) };
}
