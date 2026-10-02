import type { menuRepo } from '@sds/db';
import {
  availabilityInputSchema,
  createCategoryInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  groupIdParamSchema,
  idParamSchema,
  listItemsQuerySchema,
  PHOTO_CONTENT_TYPES,
  PHOTO_MAX_BYTES,
  patchCategoryInputSchema,
  patchGroupInputSchema,
  patchItemInputSchema,
  patchOptionInputSchema,
  photoQuerySchema,
  publicMenuQuerySchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, markPublicMediaCheck, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError, notFound } from '../errors.ts';
import { parse } from '../validate.ts';
import {
  archiveGroup,
  archiveItem,
  archiveOption,
  clearItemPhoto,
  createCategory,
  createGroup,
  createItem,
  createOption,
  deactivateCategory,
  getItem,
  listCategories,
  listCosts,
  listGroups,
  listItems,
  patchCategory,
  patchGroup,
  patchItem,
  patchOption,
  publicMenu,
  publicPhoto,
  publicPhotoBytes,
  setItemAvailability,
  setItemPhoto,
  setOptionAvailability,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const idOf = (request: FastifyRequest) => parse(idParamSchema, request.params).id;

/** The idempotency key is `clientRequestId` in the body. An Idempotency-Key header, if sent, must say the same. */
function checkIdempotencyHeader(request: FastifyRequest, clientRequestId: string | undefined) {
  const header = request.headers['idempotency-key'];
  if (
    header !== undefined &&
    (clientRequestId === undefined ||
      String(header).toLowerCase() !== clientRequestId.toLowerCase())
  ) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
      'Idempotency-Key must equal clientRequestId',
    );
  }
}

/**
 * Mounted at /v1/menu.
 * - `GET /v1/menu?channel=` is public: what can be ordered on a channel, at its price. No costs.
 * - Staff lists need `menu.availability` (every role); archived rows only for `menu.edit`.
 * - Creating, editing and deleting need `menu.edit` (managers, owner). Delete archives.
 * - Every create takes an optional `clientRequestId` (UUID): a retry with the same id and content
 *   returns the row with 200, the same id with other content is 409 IDEMPOTENCY_KEY_REUSED.
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

  // Costs: write-only in every DTO, readable here by the roles that see reports.
  app.get('/costs', { onRequest: guard('report.view') }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await listCosts(ctx)),
  );

  // Categories
  app.get('/categories', view, async () => listCategories(ctx));
  app.post('/categories', edit, async (request, reply) => {
    const input = parse(createCategoryInputSchema, request.body);
    checkIdempotencyHeader(request, input.clientRequestId);
    const { dto, replay } = await createCategory(ctx, principalOf(request), input, meta(request));
    return reply.status(replay ? 200 : 201).send(dto);
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
    const input = parse(createItemInputSchema, request.body);
    checkIdempotencyHeader(request, input.clientRequestId);
    const { dto, replay } = await createItem(ctx, principalOf(request), input, meta(request));
    return reply.status(replay ? 200 : 201).send(dto);
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
  // Photos (D-21). The body is the raw image: only these three types are parsed (as a Buffer), so
  // anything else, including text/html and image/svg+xml, is a 415 before the handler runs.
  app.addContentTypeParser(
    [...PHOTO_CONTENT_TYPES],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.put(
    '/items/:id/photo',
    { onRequest: guard('menu.edit'), bodyLimit: PHOTO_MAX_BYTES },
    async (request) =>
      setItemPhoto(
        ctx,
        principalOf(request),
        idOf(request),
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        request.headers['content-type'],
        meta(request),
      ),
  );
  app.delete('/items/:id/photo', edit, async (request) =>
    clearItemPhoto(ctx, principalOf(request), idOf(request), meta(request)),
  );

  // The one public read besides the menu itself (an <img> cannot send a header). Listed in v1.ts as
  // a public media route: the hook below answers only for a photo of an item that is on the menu, at
  // the version in the URL, and every other request gets the same 404.
  if (typeof app.rateLimit !== 'function') {
    throw new Error('the menu routes need @fastify/rate-limit to be registered first');
  }
  // A menu page loads dozens of photos and the whole condominium may share one public IP.
  const photoLimit = app.rateLimit({ max: 600, timeWindow: '1 minute' });
  const servable = new WeakMap<FastifyRequest, { itemId: string; photo: menuRepo.ServablePhoto }>();
  app.get(
    '/items/:id/photo',
    {
      onRequest: [
        photoLimit,
        markPublicMediaCheck(async (request, reply) => {
          const params = idParamSchema.safeParse(request.params);
          const query = photoQuerySchema.safeParse(request.query);
          const photo =
            params.success && query.success
              ? await publicPhoto(ctx, params.data.id, query.data.v)
              : undefined;
          if (!params.success || !photo) {
            reply.header('cache-control', 'no-store');
            throw notFound('Photo');
          }
          servable.set(request, { itemId: params.data.id, photo });
        }),
      ],
    },
    async (request, reply) => {
      const found = servable.get(request);
      if (!found) throw notFound('Photo'); // unreachable: the hook above sets it or throws
      const { itemId, photo } = found;
      const etag = `"${itemId}.${photo.version}"`;
      const headers = {
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'public, max-age=31536000, immutable',
        etag,
      };
      if (request.headers['if-none-match'] === etag)
        return reply.headers(headers).status(304).send();
      // Only a 200 reads the image. If the photo changed since the lookup, it is a miss like any other.
      const bytes = await publicPhotoBytes(ctx, itemId, photo.version);
      if (!bytes) {
        reply.header('cache-control', 'no-store');
        throw notFound('Photo');
      }
      return reply.headers(headers).header('content-type', photo.contentType).send(bytes);
    },
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
    const input = parse(createGroupInputSchema, request.body);
    checkIdempotencyHeader(request, input.clientRequestId);
    const { dto, replay } = await createGroup(ctx, principalOf(request), input, meta(request));
    return reply.status(replay ? 200 : 201).send(dto);
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
    const groupId = parse(groupIdParamSchema, request.params).groupId;
    const input = parse(createOptionInputSchema, request.body);
    checkIdempotencyHeader(request, input.clientRequestId);
    const { dto, replay } = await createOption(
      ctx,
      principalOf(request),
      groupId,
      input,
      meta(request),
    );
    return reply.status(replay ? 200 : 201).send(dto);
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
