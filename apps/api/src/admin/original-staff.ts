/**
 * `originalStaffId` on order and cash payment create (CLAUDE.md rule 9): after the owner takes over
 * another person's offline outbox, the owner's session sends the entries, and this keeps the staff
 * member who really took them in the trail. Only the owner may name someone else, so a cashier
 * cannot put a colleague's name on their own sale.
 */
import { type Db, peopleRepo } from '@sds/db';
import type { Principal } from '../auth/service.ts';
import { hasFreshStepUp } from '../auth/service.ts';
import { ApiError, conflict, forbidden, stepUpRequired } from '../errors.ts';

/**
 * Refuses a non-owner, and an owner without a fresh step-up (rule 9: naming someone else on a
 * sale is a sensitive act), before anything is read or written.
 */
export function requireOwnerForOriginalStaff(
  actor: Principal,
  originalStaffId: string | undefined,
  now: Date,
) {
  if (originalStaffId === undefined) return;
  if (actor.role !== 'owner') throw forbidden();
  if (!hasFreshStepUp(actor, now)) throw stepUpRequired();
}

/**
 * A replay that names a staff member other than the stored attribution is refused, so the trail
 * cannot be wrong without an error. Leaving the field out is always fine. The one exception keeps
 * the offline outbox working: nothing stored and the named person is the row's creator (they
 * already are the one in the trail), so there is nothing to change.
 */
export function assertReplayOriginalStaff(
  stored: { originalStaffId: string | null; creatorStaffId: string | null },
  supplied: string | undefined,
): void {
  if (supplied === undefined || supplied === stored.originalStaffId) return;
  if (stored.originalStaffId === null && supplied === stored.creatorStaffId) return;
  throw conflict(
    'IDEMPOTENCY_KEY_REUSED',
    'This request id was already used with a different original staff member',
  );
}

/** The id must belong to a staff member (a deactivated one still counts: they took the order). */
export async function assertOriginalStaffExists(tx: Db, originalStaffId: string): Promise<void> {
  if (!(await peopleRepo.findStaff(tx, originalStaffId))) {
    throw new ApiError(422, 'UNKNOWN_STAFF', 'That staff member does not exist');
  }
}
