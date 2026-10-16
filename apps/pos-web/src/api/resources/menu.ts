/** Typed API client: the menu: public read and the menu editor calls. */
import {
  availabilityInputSchema,
  categoryDtoSchema,
  createCategoryInputSchema,
  createGroupInputSchema,
  createItemInputSchema,
  createOptionInputSchema,
  groupDtoSchema,
  itemDtoSchema,
  menuCostsResponseSchema,
  optionDtoSchema,
  patchCategoryInputSchema,
  patchGroupInputSchema,
  patchItemInputSchema,
  patchOptionInputSchema,
  publicMenuQuerySchema,
  publicMenuResponseSchema,
  reorderInputSchema,
  reorderResponseSchema,
} from '@sds/shared';
import { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export type NewCategoryInput = Omit<z.input<typeof createCategoryInputSchema>, 'clientRequestId'>;
export type NewItemInput = Omit<z.input<typeof createItemInputSchema>, 'clientRequestId'>;
export type NewGroupInput = Omit<z.input<typeof createGroupInputSchema>, 'clientRequestId'>;
export type NewOptionInput = Omit<z.input<typeof createOptionInputSchema>, 'clientRequestId'>;
const categoryListSchema = z.object({ categories: z.array(categoryDtoSchema) });
const itemListSchema = z.object({ items: z.array(itemDtoSchema) });
const groupListSchema = z.object({ groups: z.array(groupDtoSchema) });

export function makeMenu({ get, post, patch, put, del, menuId, create }: Transport) {
  const menu = {
    /** What can be ordered on a channel: public, no session. Sold-out items are NOT in it. */
    publicMenu: async (channel: z.input<typeof publicMenuQuerySchema>['channel'] = 'storefront') =>
      (
        await get({
          path: '/v1/menu',
          query: checked(publicMenuQuerySchema, { channel }) as Record<string, string>,
          schema: publicMenuResponseSchema,
        })
      ).data,

    /** The staff lists keep sold-out rows (every role may read them). */
    listCategories: async () =>
      (
        await get({
          path: '/v1/menu/categories',
          schema: categoryListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** `includeArchived` is for roles with `menu.edit` (anyone else gets 403). */
    listItems: async (options: { includeArchived?: boolean } = {}) =>
      (
        await get({
          path: '/v1/menu/items',
          ...(options.includeArchived ? { query: { includeArchived: 'true' } } : {}),
          schema: itemListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    listGroups: async (options: { includeArchived?: boolean } = {}) =>
      (
        await get({
          path: '/v1/menu/modifier-groups',
          ...(options.includeArchived ? { query: { includeArchived: 'true' } } : {}),
          schema: groupListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    // ----- The menu editor (`menu.edit`) -----
    // Every create carries `clientRequestId` (body and `Idempotency-Key`). The id belongs to the
    // logical create: a caller that may retry makes it once and passes it on every attempt.
    // Every patch needs the `expectedVersion` the editor saw (409 VERSION_CONFLICT otherwise).

    createCategory: async (input: NewCategoryInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/categories', createCategoryInputSchema, categoryDtoSchema, input, options),

    patchCategory: async (id: string, input: z.input<typeof patchCategoryInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/categories/${menuId(id)}`,
          body: checked(patchCategoryInputSchema, input),
          schema: categoryDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createItem: async (input: NewItemInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/items', createItemInputSchema, itemDtoSchema, input, options),

    patchItem: async (id: string, input: z.input<typeof patchItemInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/items/${menuId(id)}`,
          body: checked(patchItemInputSchema, input),
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** The sold-out switch (หมด). */
    setItemAvailable: async (id: string, input: z.input<typeof availabilityInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/items/${menuId(id)}/availability`,
          body: checked(availabilityInputSchema, input),
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createGroup: async (input: NewGroupInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/modifier-groups', createGroupInputSchema, groupDtoSchema, input, options),

    patchGroup: async (id: string, input: z.input<typeof patchGroupInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-groups/${menuId(id)}`,
          body: checked(patchGroupInputSchema, input),
          schema: groupDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createOption: async (
      groupId: string,
      input: NewOptionInput,
      options?: { clientRequestId?: string },
    ) =>
      create(
        `/v1/menu/modifier-groups/${menuId(groupId)}/options`,
        createOptionInputSchema,
        optionDtoSchema,
        input,
        options,
      ),

    patchOption: async (id: string, input: z.input<typeof patchOptionInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-options/${menuId(id)}`,
          body: checked(patchOptionInputSchema, input),
          schema: optionDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    setOptionAvailable: async (id: string, input: z.input<typeof availabilityInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-options/${menuId(id)}/availability`,
          body: checked(availabilityInputSchema, input),
          schema: optionDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** One sibling set in its new order, atomically. Idempotent: no request id. */
    reorder: async (input: z.input<typeof reorderInputSchema>) =>
      (
        await post({
          path: '/v1/menu/reorder',
          body: checked(reorderInputSchema, input),
          schema: reorderResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The costs of items and options, for roles with `report.view`. They are in no other answer
     * and in nothing the app saves: keep them in memory, for the editor only.
     */
    costs: async () =>
      (
        await get({
          path: '/v1/menu/costs',
          schema: menuCostsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * Stores the item's photo. `photo` must already be re-encoded (`platform/photo.ts`): the server
     * does not strip location data. The type sent is the blob's own, not a guess.
     */
    putPhoto: async (id: string, photo: Blob) =>
      (
        await put({
          path: `/v1/menu/items/${menuId(id)}/photo`,
          rawBody: { data: photo, contentType: photo.type },
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    removePhoto: async (id: string) =>
      (
        await del({
          path: `/v1/menu/items/${menuId(id)}/photo`,
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
  };

  return menu;
}
