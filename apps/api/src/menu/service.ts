/**
 * Menu (02 §6, 03 §3): categories, items, modifier groups and options. Every write is one
 * transaction: lock the row, check `expectedVersion`, write (the sync trigger bumps version and
 * rev), audit with before/after of what changed, publish `menu.upserted` after commit.
 *
 * Prices are integer satang. Estimated costs are accepted and stored, and read back only by `listCosts`.
 * Nothing is ever hard-deleted: DELETE archives (or deactivates a category), so past orders keep
 * pointing at a real row and keep the names and prices they were sold with.
 */

export { createCategory, deactivateCategory, patchCategory } from './categories.ts';
export { toCategory, toGroup, toItem, toOption } from './dto.ts';
export {
  archiveGroup,
  archiveOption,
  createGroup,
  createOption,
  patchGroup,
  patchOption,
  setOptionAvailability,
} from './groups.ts';
export type { Created } from './internal.ts';
export { archiveItem, createItem, patchItem, setItemAvailability } from './items.ts';
export { clearItemPhoto, publicPhoto, publicPhotoBytes, setItemPhoto } from './photos.ts';
export { getItem, listCategories, listCosts, listGroups, listItems, publicMenu } from './reads.ts';
export { reorder } from './reorder.ts';
