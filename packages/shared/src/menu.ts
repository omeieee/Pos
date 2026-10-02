/**
 * Menu API shapes (02 §6, 03 §3 "Menu"). Prices are integer satang. Costs (`est_cost_satang`,
 * `cost_delta_satang`) can be written by managers but are never in any response: a kitchen tablet
 * or a customer must not see what a bowl costs. Photos are stored by the API (D-21): `photoUrl`.
 */
import { z } from 'zod';
import { MENU_CHANNELS } from './enums.ts';
import { ZERO } from './money.ts';
import { nonNegativeSatangSchema, satangSchema } from './schemas.ts';

const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().min(1).max(max);
const sort = z.number().int().min(-100000).max(100000);
const menuChannel = z.enum(MENU_CHANNELS);

function needsAField<T extends { expectedVersion: number }>(v: T): boolean {
  return Object.keys(v).some(
    (k) => k !== 'expectedVersion' && (v as Record<string, unknown>)[k] !== undefined,
  );
}
const needsAFieldMessage = {
  message: 'give at least one field to change',
  path: ['expectedVersion'],
};

/**
 * Idempotency for the create routes (CLAUDE.md rule 6), optional: a client that may retry (the
 * offline outbox, a double tap) sends a fresh UUID per new row. The same id with the same content
 * returns the row that was made (200); the same id with other content is refused (409
 * IDEMPOTENCY_KEY_REUSED). Never part of a response.
 */
const clientRequestId = z.uuid().optional();

const imageUrl = z.url({ protocol: /^https$/ }).max(500);
const channelsSchema = z
  .array(menuChannel)
  .min(1)
  .refine((c) => new Set(c).size === c.length, { message: 'each channel once' });
const channelPricesSchema = z.strictObject({
  storefront: nonNegativeSatangSchema.optional(),
  line: nonNegativeSatangSchema.optional(),
  grab: nonNegativeSatangSchema.optional(),
  lineman: nonNegativeSatangSchema.optional(),
});
const groupIdsSchema = z
  .array(z.uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'each group once' });

export const groupIdParamSchema = z.object({ groupId: z.uuid() });

/**
 * Where an item's photo is served (D-21): a path under the API, public to read. `v` is the item's
 * `photoVersion`; it makes the URL change whenever the photo does, which is why the response can be
 * cached forever. Clients prefix their API base.
 */
export function menuPhotoPath(itemId: string, photoVersion: number): string {
  return `/v1/menu/items/${itemId}/photo?v=${photoVersion}`;
}

/** The query of `GET /v1/menu/items/:id/photo`. A wrong or stale `v` is a 404, never a 400. */
export const photoQuerySchema = z.object({ v: z.coerce.number().int().min(1).max(2_147_483_647) });

// ---------- Categories ----------

export const categoryDtoSchema = z.object({
  id: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  sort: z.number().int(),
  active: z.boolean(),
  version,
  rev: z.number().int().min(0),
});
export type CategoryDto = z.infer<typeof categoryDtoSchema>;

export const createCategoryInputSchema = z.strictObject({
  nameTh: text(80),
  nameEn: text(80).nullable().optional(),
  sort: sort.default(0),
  clientRequestId,
});
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;

export const patchCategoryInputSchema = z
  .strictObject({
    expectedVersion: version,
    nameTh: text(80).optional(),
    nameEn: text(80).nullable().optional(),
    sort: sort.optional(),
    active: z.boolean().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type PatchCategoryInput = z.infer<typeof patchCategoryInputSchema>;

// ---------- Modifier groups and options ----------

export const optionDtoSchema = z.object({
  id: z.uuid(),
  groupId: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  priceDeltaSatang: satangSchema,
  isAvailable: z.boolean(),
  sort: z.number().int(),
  archived: z.boolean(),
  version,
  rev: z.number().int().min(0),
});
export type OptionDto = z.infer<typeof optionDtoSchema>;

const optionFields = {
  nameTh: text(80),
  nameEn: text(80).nullable().optional(),
  priceDeltaSatang: satangSchema.default(ZERO),
  /** Estimated cost change per unit. Write-only. */
  costDeltaSatang: satangSchema.default(ZERO),
  isAvailable: z.boolean().default(true),
  sort: sort.default(0),
};
/** An option made together with its group: the group's request id covers it. */
const newGroupOptionSchema = z.strictObject(optionFields);

export const createOptionInputSchema = z.strictObject({ ...optionFields, clientRequestId });
export type CreateOptionInput = z.infer<typeof createOptionInputSchema>;

export const patchOptionInputSchema = z
  .strictObject({
    expectedVersion: version,
    nameTh: text(80).optional(),
    nameEn: text(80).nullable().optional(),
    priceDeltaSatang: satangSchema.optional(),
    costDeltaSatang: satangSchema.optional(),
    isAvailable: z.boolean().optional(),
    sort: sort.optional(),
    archived: z.boolean().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type PatchOptionInput = z.infer<typeof patchOptionInputSchema>;

export const groupDtoSchema = z.object({
  id: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(1),
  sort: z.number().int(),
  archived: z.boolean(),
  options: z.array(optionDtoSchema),
  version,
  rev: z.number().int().min(0),
});
export type GroupDto = z.infer<typeof groupDtoSchema>;

const selectRange = (v: { minSelect?: number | undefined; maxSelect?: number | undefined }) =>
  v.minSelect === undefined || v.maxSelect === undefined || v.minSelect <= v.maxSelect;
const selectRangeMessage = { message: 'minSelect must not exceed maxSelect', path: ['minSelect'] };

export const createGroupInputSchema = z
  .strictObject({
    nameTh: text(80),
    nameEn: text(80).nullable().optional(),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    sort: sort.default(0),
    options: z.array(newGroupOptionSchema).max(50).optional(),
    clientRequestId,
  })
  .refine(selectRange, selectRangeMessage);
export type CreateGroupInput = z.infer<typeof createGroupInputSchema>;

export const patchGroupInputSchema = z
  .strictObject({
    expectedVersion: version,
    nameTh: text(80).optional(),
    nameEn: text(80).nullable().optional(),
    minSelect: z.number().int().min(0).max(20).optional(),
    maxSelect: z.number().int().min(1).max(20).optional(),
    sort: sort.optional(),
    archived: z.boolean().optional(),
  })
  .refine(needsAField, needsAFieldMessage)
  .refine(selectRange, selectRangeMessage);
export type PatchGroupInput = z.infer<typeof patchGroupInputSchema>;

// ---------- Items ----------

export const itemDtoSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  descriptionTh: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  priceSatang: nonNegativeSatangSchema,
  imageUrl: z.string().nullable(),
  /** The photo's version (D-21), null or absent when the item has none. Refetch when it changes. */
  photoVersion: z.number().int().min(1).nullish(),
  /** `menuPhotoPath(id, photoVersion)`: relative to the API base, null or absent without a photo. */
  photoUrl: z.string().nullish(),
  isAvailable: z.boolean(),
  channels: z.array(menuChannel),
  channelPrices: z.partialRecord(menuChannel, nonNegativeSatangSchema),
  modifierGroupIds: z.array(z.uuid()),
  sort: z.number().int(),
  archived: z.boolean(),
  version,
  rev: z.number().int().min(0),
});
export type ItemDto = z.infer<typeof itemDtoSchema>;

const itemFields = {
  categoryId: z.uuid(),
  nameTh: text(80),
  nameEn: text(80).nullable(),
  descriptionTh: z.string().trim().max(500).nullable(),
  descriptionEn: z.string().trim().max(500).nullable(),
  priceSatang: nonNegativeSatangSchema,
  /** Estimated cost of one unit. Write-only. */
  estCostSatang: nonNegativeSatangSchema,
  imageUrl: imageUrl.nullable(),
  channels: channelsSchema,
  /** Replaces all channel price overrides when given. */
  channelPrices: channelPricesSchema,
  /** Replaces the attached modifier groups (in this order) when given. */
  modifierGroupIds: groupIdsSchema,
  sort,
  isAvailable: z.boolean(),
};

export const createItemInputSchema = z.strictObject({
  categoryId: itemFields.categoryId,
  nameTh: itemFields.nameTh,
  nameEn: itemFields.nameEn.optional(),
  descriptionTh: itemFields.descriptionTh.optional(),
  descriptionEn: itemFields.descriptionEn.optional(),
  priceSatang: itemFields.priceSatang,
  estCostSatang: itemFields.estCostSatang.default(ZERO),
  imageUrl: itemFields.imageUrl.optional(),
  channels: itemFields.channels,
  channelPrices: itemFields.channelPrices.optional(),
  modifierGroupIds: itemFields.modifierGroupIds.optional(),
  sort: itemFields.sort.default(0),
  isAvailable: itemFields.isAvailable.default(true),
  clientRequestId,
});
export type CreateItemInput = z.infer<typeof createItemInputSchema>;

export const patchItemInputSchema = z
  .strictObject({
    expectedVersion: version,
    categoryId: itemFields.categoryId.optional(),
    nameTh: itemFields.nameTh.optional(),
    nameEn: itemFields.nameEn.optional(),
    descriptionTh: itemFields.descriptionTh.optional(),
    descriptionEn: itemFields.descriptionEn.optional(),
    priceSatang: itemFields.priceSatang.optional(),
    estCostSatang: itemFields.estCostSatang.optional(),
    imageUrl: itemFields.imageUrl.optional(),
    channels: itemFields.channels.optional(),
    channelPrices: itemFields.channelPrices.optional(),
    modifierGroupIds: itemFields.modifierGroupIds.optional(),
    sort: itemFields.sort.optional(),
    isAvailable: itemFields.isAvailable.optional(),
    /** Soft delete: an archived item leaves the menu but stays on past orders. */
    archived: z.boolean().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type PatchItemInput = z.infer<typeof patchItemInputSchema>;

/** The "sold out" toggle (หมด). The version is optional: the target state is explicit. */
export const availabilityInputSchema = z.strictObject({
  isAvailable: z.boolean(),
  expectedVersion: version.optional(),
});
export type AvailabilityInput = z.infer<typeof availabilityInputSchema>;

export const listItemsQuerySchema = z.object({
  /** Archived items too (menu.edit only). */
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// ---------- Public menu ----------

export const publicMenuQuerySchema = z.object({ channel: menuChannel.default('storefront') });
export type PublicMenuQuery = z.infer<typeof publicMenuQuerySchema>;

const publicOptionSchema = z.object({
  id: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  priceDeltaSatang: satangSchema,
});
const publicGroupSchema = z.object({
  id: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  minSelect: z.number().int(),
  maxSelect: z.number().int(),
  options: z.array(publicOptionSchema),
});
const publicItemSchema = z.object({
  id: z.uuid(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  descriptionTh: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  /** The price on the requested channel: the channel override if there is one, else the base price. */
  priceSatang: nonNegativeSatangSchema,
  imageUrl: z.string().nullable(),
  /** The photo's path (`menuPhotoPath`), relative to the API base; null or absent without one. */
  photoUrl: z.string().nullish(),
  modifierGroups: z.array(publicGroupSchema),
});
export const publicMenuResponseSchema = z.object({
  channel: menuChannel,
  categories: z.array(
    z.object({
      id: z.uuid(),
      nameTh: z.string(),
      nameEn: z.string().nullable(),
      items: z.array(publicItemSchema),
    }),
  ),
});
export type PublicMenuResponse = z.infer<typeof publicMenuResponseSchema>;
