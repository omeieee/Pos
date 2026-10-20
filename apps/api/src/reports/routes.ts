import { revenueReportQuerySchema, taxReportQuerySchema } from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { CoreContext } from '../tx.ts';
import { parse } from '../validate.ts';
import { exportCsv } from './export.ts';
import {
  customersReport,
  heatmapReport,
  itemsReport,
  pnlReport,
  revenueReport,
} from './service.ts';
import { taxReport } from './tax.ts';

/** Mounted at /v1/reports. Revenue, items and heatmap need `report.view` (owner and manager); customers needs `customer.report` (owner); pnl and tax need `finance.pnl` (owner). */
export async function registerReportRoutes(
  app: FastifyInstance,
  ctx: CoreContext,
  guard: GuardFactory,
): Promise<void> {
  app.get('/revenue', { onRequest: guard('report.view') }, async (request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send(await revenueReport(ctx.db, parse(revenueReportQuerySchema, request.query))),
  );

  app.get('/items', { onRequest: guard('report.view') }, async (request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send(await itemsReport(ctx.db, parse(revenueReportQuerySchema, request.query))),
  );

  // Personal data (names, buildings, spending): owner only, `customer.report`, never cached.
  app.get('/customers', { onRequest: guard('customer.report') }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await customersReport(ctx.db, ctx.now())),
  );

  // Profit and loss: owner only (`finance.pnl`); managers enter expenses but do not see it. Read only, never cached.
  app.get('/pnl', { onRequest: guard('finance.pnl') }, async (request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send(await pnlReport(ctx.db, parse(revenueReportQuerySchema, request.query))),
  );

  // Income tax estimate (P7): owner only (`finance.pnl`), read only, never cached. Not a filing.
  app.get('/tax', { onRequest: guard('finance.pnl') }, async (request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send(await taxReport(ctx.db, parse(taxReportQuerySchema, request.query), ctx.now())),
  );

  // The accountant's files. `data.export` is owner only and needs a fresh step-up; each export is audited.
  for (const kind of ['revenue', 'items'] as const) {
    app.get(`/export/${kind}.csv`, { onRequest: guard('data.export') }, async (request, reply) => {
      const file = await exportCsv(
        ctx.db,
        principalOf(request),
        { ip: request.ip ?? null },
        kind,
        parse(revenueReportQuerySchema, request.query),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .header('cache-control', 'no-store')
        .send(file.body);
    });
  }

  app.get('/heatmap', { onRequest: guard('report.view') }, async (request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send(await heatmapReport(ctx.db, parse(revenueReportQuerySchema, request.query))),
  );
}
