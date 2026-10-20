import { putTaxProfileInputSchema, taxReportQuerySchema } from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { parse } from '../validate.ts';
import { patchGovCopay, patchSetting, RESOURCES, readGovCopay, readSetting } from './service.ts';
import { putTaxProfile, readTaxProfile } from './tax-profile.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });

/**
 * Mounted at /v1/settings: shop, opening-hours, numbering, payments, delivery, promptpay, receipt, bank-account, platform-commission, tax-profile, gov-copay.
 * Reading needs `settings.view` (cashiers need the PromptPay ID for the QR, and the scheme for
 * the method list). Changing needs `settings.edit` (managers and the owner), except the PromptPay
 * ID (`settings.promptpay`) and the co-pay scheme (`settings.gov_copay`): owner only, with a
 * fresh step-up. The `line` settings come with P4.
 */
export async function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  for (const resource of RESOURCES) {
    app.get(`/${resource.route}`, { onRequest: guard('settings.view') }, async (request) =>
      readSetting(ctx, resource, principalOf(request).role),
    );
    const change = async (request: FastifyRequest) =>
      patchSetting(ctx, principalOf(request), resource, request.body, meta(request));
    app.patch(`/${resource.route}`, { onRequest: guard(resource.editPermission) }, change);
    // The building list is replaced as a whole, so it also answers PUT.
    if (resource.put) {
      app.put(`/${resource.route}`, { onRequest: guard(resource.editPermission) }, change);
    }
  }

  // The owner's tax inputs per tax year (P7): read needs `finance.pnl` (owner only: cashiers hold
  // `settings.view` but must not see them), save needs `settings.tax_profile` (owner, step-up, audit).
  const yearOf = (request: FastifyRequest) =>
    parse(taxReportQuerySchema.pick({ year: true }), request.query).year;
  app.get('/tax-profile', { onRequest: guard('finance.pnl') }, async (request) =>
    readTaxProfile(ctx, yearOf(request)),
  );
  app.put('/tax-profile', { onRequest: guard('settings.tax_profile') }, async (request) =>
    putTaxProfile(
      ctx,
      principalOf(request),
      yearOf(request),
      parse(putTaxProfileInputSchema, request.body),
      meta(request),
    ),
  );

  app.get('/gov-copay', { onRequest: guard('settings.view') }, async () => readGovCopay(ctx));
  app.patch('/gov-copay', { onRequest: guard('settings.gov_copay') }, async (request) =>
    patchGovCopay(ctx, principalOf(request), request.body, meta(request)),
  );
}
