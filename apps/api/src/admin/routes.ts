import {
  createStaffInputSchema,
  idParamSchema,
  patchStaffInputSchema,
  setStaffPinInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { parse } from '../validate.ts';
import {
  createStaffMember,
  listDevices,
  listStaffMembers,
  patchStaffMember,
  revokeDevice,
  setStaffPin,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const idOf = (request: FastifyRequest) => parse(idParamSchema, request.params).id;

/**
 * Mounted at /v1: /devices and /staff. The owner only (`device.manage`, `staff.manage`), and both
 * are step-up permissions, so every route here also needs a fresh step-up. Creating staff takes no
 * Idempotency-Key: a duplicate is visible in the list and is deactivated with one PATCH.
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
): Promise<void> {
  // Lists of people and devices are not for a browser or proxy cache.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/devices', { onRequest: guard('device.manage') }, async () => listDevices(ctx));

  app.post('/devices/:id/revoke', { onRequest: guard('device.manage') }, async (request) =>
    revokeDevice(ctx, principalOf(request), idOf(request), meta(request)),
  );

  app.get('/staff', { onRequest: guard('staff.manage') }, async () => listStaffMembers(ctx));

  app.post('/staff', { onRequest: guard('staff.manage') }, async (request, reply) => {
    const input = parse(createStaffInputSchema, request.body);
    const created = await createStaffMember(ctx, principalOf(request), input, meta(request));
    return reply.status(201).send(created);
  });

  app.patch('/staff/:id', { onRequest: guard('staff.manage') }, async (request) =>
    patchStaffMember(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchStaffInputSchema, request.body),
      meta(request),
    ),
  );

  app.post('/staff/:id/pin', { onRequest: guard('staff.manage') }, async (request) =>
    setStaffPin(
      ctx,
      principalOf(request),
      idOf(request),
      parse(setStaffPinInputSchema, request.body),
      meta(request),
    ),
  );
}
