/**
 * `originalStaffId` on order and cash payment create (CLAUDE.md rule 9): after the owner takes over
 * another person's offline outbox, the owner's session sends the entries, and this keeps the staff
 * member who really took them in the trail. Only the owner may name someone else, so a cashier
 * cannot put a colleague's name on their own sale.
 */
import { type Db, peopleRepo } from '@sds/db';
import type { Principal } from '../auth/service.ts';
import { ApiError, forbidden } from '../errors.ts';

/** Refuses a non-owner before anything is read or written. */
export function requireOwnerForOriginalStaff(
  actor: Principal,
  originalStaffId: string | undefined,
) {
  if (originalStaffId !== undefined && actor.role !== 'owner') throw forbidden();
}

/** The id must belong to a staff member (a deactivated one still counts: they took the order). */
export async function assertOriginalStaffExists(tx: Db, originalStaffId: string): Promise<void> {
  if (!(await peopleRepo.findStaff(tx, originalStaffId))) {
    throw new ApiError(422, 'UNKNOWN_STAFF', 'That staff member does not exist');
  }
}
