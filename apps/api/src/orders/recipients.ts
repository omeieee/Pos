import { customersRepo } from '@sds/db';
import {
  type RecipientsResponse,
  recipientKey,
  recipientsQuerySchema,
  recipientsResponseSchema,
} from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import type { GuardFactory } from '../auth/guards.ts';
import type { CoreContext } from '../tx.ts';
import { parse } from '../validate.ts';

/**
 * Mounted at /v1/recipients. `GET /v1/recipients?q=&building=&limit=` lists the recipients the shop
 * has delivered to, most recent first, for the order screen's chips and prefill (owner,
 * 2026-10-02). Anyone who may create an order may read it (`order.create`: cashier, manager,
 * owner); the kitchen may not. It returns five fields and nothing else (never a phone, LINE id,
 * picture, consent date or order history). It is personal data (PDPA): `no-store`, no audit row
 * (a read, as the order list is), and the search text is kept out of the request log line.
 */
export async function registerRecipientRoutes(
  app: FastifyInstance,
  ctx: CoreContext,
  guard: GuardFactory,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/',
    { onRequest: guard('order.create') },
    async (request): Promise<RecipientsResponse> => {
      const query = parse(recipientsQuerySchema, request.query);
      const rows = await customersRepo.listRecipients(ctx.db, {
        limit: query.limit,
        ...(query.building ? { building: query.building } : {}),
        ...(query.q ? { nameKey: recipientKey(query.q) } : {}),
      });
      return recipientsResponseSchema.parse({
        recipients: rows.map((row) => ({
          id: row.id,
          building: row.building,
          recipientName: row.recipientName,
          deliveryNote: row.deliveryNote,
          lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
        })),
      });
    },
  );
}
