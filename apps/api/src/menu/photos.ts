/**
 * Menu: item photos stored in Postgres (D-21).
 */
import { insertAudit, menuRepo } from '@sds/db';
import { checkPhoto, type ItemDto, type PhotoCheck } from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, notFound, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { itemDto } from './dto.ts';
import { actorOf, publish } from './internal.ts';

// ---------- Photos (D-21) ----------

type PhotoFailure = Extract<PhotoCheck, { ok: false }>['reason'];

const PHOTO_ERRORS: Record<PhotoFailure, [status: number, code: string, message: string]> = {
  empty: [422, 'PHOTO_EMPTY', 'The photo is empty'],
  too_big: [413, 'PHOTO_TOO_LARGE', 'The photo is too large. Shrink it and try again'],
  not_an_image: [415, 'PHOTO_NOT_AN_IMAGE', 'The file is not a WebP, JPEG or PNG image'],
  type_mismatch: [415, 'PHOTO_TYPE_MISMATCH', 'The Content-Type does not match the image'],
  too_many_pixels: [422, 'PHOTO_TOO_MANY_PIXELS', 'The photo is more than 1200 pixels on a side'],
};

/**
 * Stores the item's photo (replacing any), in one transaction with the item row: the item's version
 * and rev move and `photoVersion` becomes that new version, so it grows with every change and a URL
 * is never reused. The same bytes again change nothing. The audit row has the size, never the bytes.
 */
export async function setItemPhoto(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  body: Buffer,
  declaredContentType: string | undefined,
  meta: RequestMeta,
): Promise<ItemDto> {
  const check = checkPhoto(body, declaredContentType);
  if (!check.ok) {
    const [status, code, message] = PHOTO_ERRORS[check.reason];
    throw new ApiError(status, code, message);
  }
  const { info } = check;
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockItem(tx, id);
    if (!row) throw notFound('Menu item');
    const current = await menuRepo.findPhoto(tx, id);
    if (
      current &&
      row.photoVersion === current.version &&
      current.contentType === info.contentType &&
      current.bytes.equals(body)
    ) {
      return itemDto(tx, row);
    }
    const version = row.version + 1; // what the sync trigger is about to make the item's version
    await menuRepo.setPhoto(tx, id, {
      contentType: info.contentType,
      bytes: body,
      width: info.width,
      height: info.height,
      version,
    });
    const updated = await menuRepo.updateItemIfVersion(tx, id, row.version, {
      photoVersion: version,
    });
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.item_photo_set',
      entity: 'menu_items',
      entityId: id,
      before: { photoVersion: row.photoVersion },
      after: {
        photoVersion: version,
        contentType: info.contentType,
        byteSize: body.length,
        width: info.width,
        height: info.height,
      },
    });
    const dto = await itemDto(tx, updated);
    publish(emit, 'item', id, updated.rev, dto);
    return dto;
  });
}

/** Removes the photo. An item without one is returned as it is: nothing written, audited or sent. */
export async function clearItemPhoto(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<ItemDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await menuRepo.lockItem(tx, id);
    if (!row) throw notFound('Menu item');
    const removed = await menuRepo.deletePhoto(tx, id);
    if (!removed && row.photoVersion === null) return itemDto(tx, row);
    const updated = await menuRepo.updateItemIfVersion(tx, id, row.version, { photoVersion: null });
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'menu.item_photo_remove',
      entity: 'menu_items',
      entityId: id,
      before: { photoVersion: row.photoVersion },
      after: { photoVersion: null },
    });
    const dto = await itemDto(tx, updated);
    publish(emit, 'item', id, updated.rev, dto);
    return dto;
  });
}

/**
 * The photo a public request may see: the item's current photo at exactly `version`, for an item
 * that is not archived in an active category. `undefined` for everything else, one answer for all.
 */
export async function publicPhoto(ctx: AuthContext, id: string, version: number) {
  const photo = await menuRepo.findServablePhoto(ctx.db, id);
  return photo && photo.version === version ? photo : undefined;
}

/** The bytes of a photo `publicPhoto` just approved; `undefined` if it changed in between. */
export const publicPhotoBytes = (ctx: AuthContext, id: string, version: number) =>
  menuRepo.findPhotoBytes(ctx.db, id, version);
