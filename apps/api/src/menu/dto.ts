/**
 * Menu: rows to API shapes (no cost anywhere).
 */
import { type Db, menuRepo, type syncRepo } from '@sds/db';
import {
  type CategoryDto,
  categoryDtoSchema,
  type GroupDto,
  groupDtoSchema,
  type ItemDto,
  itemDtoSchema,
  menuPhotoPath,
  type OptionDto,
  optionDtoSchema,
} from '@sds/shared';

// ---------- Mapping rows to the API shapes (no cost anywhere) ----------

export const toCategory = (r: syncRepo.SyncCategoryRow): CategoryDto =>
  categoryDtoSchema.parse({
    id: r.id,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    sort: r.sort,
    active: r.active,
    version: r.version,
    rev: r.rev,
  });

export const toOption = (r: syncRepo.SyncOptionRow): OptionDto =>
  optionDtoSchema.parse({
    id: r.id,
    groupId: r.groupId,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    priceDeltaSatang: r.priceDeltaSatang,
    isAvailable: r.isAvailable,
    sort: r.sort,
    archived: r.archivedAt !== null,
    version: r.version,
    rev: r.rev,
  });

export const toGroup = (
  r: syncRepo.SyncGroupRow,
  options: readonly syncRepo.SyncOptionRow[],
): GroupDto =>
  groupDtoSchema.parse({
    id: r.id,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    minSelect: r.minSelect,
    maxSelect: r.maxSelect,
    sort: r.sort,
    archived: r.archivedAt !== null,
    options: options.map(toOption),
    version: r.version,
    rev: r.rev,
  });

export function toItem(r: syncRepo.SyncItemRow, extras: menuRepo.ItemExtras): ItemDto {
  return itemDtoSchema.parse({
    id: r.id,
    categoryId: r.categoryId,
    nameTh: r.nameTh,
    nameEn: r.nameEn,
    descriptionTh: r.descriptionTh,
    descriptionEn: r.descriptionEn,
    priceSatang: r.priceSatang,
    imageUrl: r.imageKey,
    photoVersion: r.photoVersion,
    photoUrl: r.photoVersion === null ? null : menuPhotoPath(r.id, r.photoVersion),
    isAvailable: r.isAvailable,
    channels: r.channels,
    channelPrices: extras.channelPrices.get(r.id) ?? {},
    modifierGroupIds: extras.groupIds.get(r.id) ?? [],
    sort: r.sort,
    archived: r.archivedAt !== null,
    version: r.version,
    rev: r.rev,
  });
}

export async function itemDto(db: Db, row: menuRepo.ItemRow): Promise<ItemDto> {
  return toItem(row, await menuRepo.loadItemExtras(db, [row.id]));
}

export async function groupDto(
  db: Db,
  row: menuRepo.GroupRow,
  includeArchived = false,
): Promise<GroupDto> {
  return toGroup(row, await menuRepo.listOptions(db, [row.id], { includeArchived }));
}
