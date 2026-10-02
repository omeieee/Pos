import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { patchGovCopay, patchSetting, RESOURCES, readGovCopay, readSetting } from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });

/**
 * Mounted at /v1/settings: shop, opening-hours, numbering, payments, delivery, promptpay, gov-copay.
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
    app.get(`/${resource.route}`, { onRequest: guard('settings.view') }, async () =>
      readSetting(ctx, resource),
    );
    const change = async (request: FastifyRequest) =>
      patchSetting(ctx, principalOf(request), resource, request.body, meta(request));
    app.patch(`/${resource.route}`, { onRequest: guard(resource.editPermission) }, change);
    // The building list is replaced as a whole, so it also answers PUT.
    if (resource.put) {
      app.put(`/${resource.route}`, { onRequest: guard(resource.editPermission) }, change);
    }
  }

  app.get('/gov-copay', { onRequest: guard('settings.view') }, async () => readGovCopay(ctx));
  app.patch('/gov-copay', { onRequest: guard('settings.gov_copay') }, async (request) =>
    patchGovCopay(ctx, principalOf(request), request.body, meta(request)),
  );
}
