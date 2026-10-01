import {
  availabilityInputSchema,
  createCategoryInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  groupIdParamSchema,
  idParamSchema,
  listItemsQuerySchema,
  patchCategoryInputSchema,
  patchGroupInputSchema,
  patchItemInputSchema,
  patchOptionInputSchema,
  publicMenuQuerySchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { parse } from '../validate.ts';
import {
  archiveGroup,
  archiveItem,
  archiveOption,
  createCategory,
  createGroup,
  createItem,
  createOption,
  deactivateCategory,
  getItem,
  listCategories,
  listGroups,
  listItems,
  patchCategory,
  patchGroup,
  patchItem,
  patchOption,
  publicMenu,
  setItemAvailability,
  setOptionAvailability,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const idOf = (request: FastifyRequest) => parse(idParamSchema, request.params).id;

/**
 * Mounted at /v1/menu.
 * - `GET /v1/menu?channel=` is public: what can be ordered on a channel, at its price. No costs.
 * - Staff lists need `menu.availability` (every role); archived rows only for `menu.edit`.
 * - Creating, editing and deleting need `menu.edit` (managers, owner). Delete archives.
 * - The sold-out toggles need only `menu.availability`, so the kitchen can mark "หมด".
 */
export async function registerMenuRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
): Promise<void> {
  // One URL, with no trailing-slash twin, so the open-route list has a single entry.
  app.get(
    '',
    {
      prefixTrailingSlash: 'no-slash',
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => publicMenu(ctx, parse(publicMenuQuerySchema, request.query).channel),
  );

  const view = { onRequest: guard('menu.availability') };
  const edit = { onRequest: guard('menu.edit') };

  // Categories
  app.get('/categories', view, async () => listCategories(ctx));
  app.post('/categories', edit, async (request, reply) => {
    const created = await createCategory(
      ctx,
      principalOf(request),
      parse(createCategoryInputSchema, request.body),
      meta(request),
    );
    return reply.status(201).send(created);
  });
  app.patch('/categories/:id', edit, async (request) =>
    patchCategory(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchCategoryInputSchema, request.body),
      meta(request),
    ),
  );
  app.delete('/categories/:id', edit, async (request) =>
    deactivateCategory(ctx, principalOf(request), idOf(request), meta(request)),
  );

  // Items
  app.get('/items', view, async (request) =>
    listItems(
      ctx,
      principalOf(request),
      parse(listItemsQuerySchema, request.query).includeArchived,
    ),
  );
  app.get('/items/:id', view, async (request) => getItem(ctx, idOf(request)));
  app.post('/items', edit, async (request, reply) => {
    const created = await createItem(
      ctx,
      principalOf(request),
      parse(createItemInputSchema, request.body),
      meta(request),
    );
    return reply.status(201).send(created);
  });
  app.patch('/items/:id', edit, async (request) =>
    patchItem(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchItemInputSchema, request.body),
      meta(request),
    ),
  );
  app.delete('/items/:id', edit, async (request) =>
    archiveItem(ctx, principalOf(request), idOf(request), meta(request)),
  );
  app.patch('/items/:id/availability', view, async (request) =>
    setItemAvailability(
      ctx,
      principalOf(request),
      idOf(request),
      parse(availabilityInputSchema, request.body),
      meta(request),
    ),
  );

  // Modifier groups and their options
  app.get('/modifier-groups', view, async (request) =>
    listGroups(
      ctx,
      principalOf(request),
      parse(listItemsQuerySchema, request.query).includeArchived,
    ),
  );
  app.post('/modifier-groups', edit, async (request, reply) => {
    const created = await createGroup(
      ctx,
      principalOf(request),
      parse(createGroupInputSchema, request.body),
      meta(request),
    );
    return reply.status(201).send(created);
  });
  app.patch('/modifier-groups/:id', edit, async (request) =>
    patchGroup(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchGroupInputSchema, request.body),
      meta(request),
    ),
  );
  app.delete('/modifier-groups/:id', edit, async (request) =>
    archiveGroup(ctx, principalOf(request), idOf(request), meta(request)),
  );
  app.post('/modifier-groups/:groupId/options', edit, async (request, reply) => {
    const created = await createOption(
      ctx,
      principalOf(request),
      parse(groupIdParamSchema, request.params).groupId,
      parse(createOptionInputSchema, request.body),
      meta(request),
    );
    return reply.status(201).send(created);
  });
  app.patch('/modifier-options/:id', edit, async (request) =>
    patchOption(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchOptionInputSchema, request.body),
      meta(request),
    ),
  );
  app.delete('/modifier-options/:id', edit, async (request) =>
    archiveOption(ctx, principalOf(request), idOf(request), meta(request)),
  );
  app.patch('/modifier-options/:id/availability', view, async (request) =>
    setOptionAvailability(
      ctx,
      principalOf(request),
      idOf(request),
      parse(availabilityInputSchema, request.body),
      meta(request),
    ),
  );
}
