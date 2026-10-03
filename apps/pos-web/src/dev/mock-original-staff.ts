/**
 * `originalStaffId` on order and cash payment create, answered the way apps/api does (see
 * apps/api/src/admin/original-staff.ts), so the owner's take-over of another person's offline
 * entries can be tried and tested against real status codes:
 * - only the owner may name someone (403 FORBIDDEN), and naming needs a fresh step-up (403
 *   STEP_UP_REQUIRED). Both are checked BEFORE the request id is looked at, so a replay needs the
 *   step-up too;
 * - an unknown staff member is 422 UNKNOWN_STAFF (only when a row is made, not on a replay);
 * - a replay that names someone other than the stored person is 409 IDEMPOTENCY_KEY_REUSED. Leaving
 *   the name out is always fine, and so is naming the person who made the row when nothing was
 *   stored (the cashier's own entry that already landed, replayed by the owner).
 * Everything here is made up and nothing is persisted.
 */
import type { MockAnswer, MockCaller } from './mock-payments.ts';

const fail = (status: number, code: string): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details: {} },
});

/** Owner only, with a fresh step-up, whenever a name is given. */
export function originalStaffGate(
  caller: MockCaller,
  named: string | undefined,
): MockAnswer | null {
  if (named === undefined) return null;
  if (caller.role !== 'owner') return fail(403, 'FORBIDDEN');
  if (!caller.stepUpFresh) return fail(403, 'STEP_UP_REQUIRED');
  return null;
}

/** The named person has to exist (a caller that cannot tell lets it pass). */
export function originalStaffKnown(
  caller: MockCaller,
  named: string | undefined,
): MockAnswer | null {
  if (named === undefined || !caller.staffKnown || caller.staffKnown(named)) return null;
  return fail(422, 'UNKNOWN_STAFF');
}

export interface Attribution {
  /** Remembers who a new row was named for and who made it. */
  remember(requestId: string, original: string | undefined, creator: string | undefined): void;
  /** The refusal for a replay that names the wrong person, or null. */
  replayRefusal(requestId: string, supplied: string | undefined): MockAnswer | null;
  /** Dev and tests: request id -> who made it and who it was named for. */
  list(): { requestId: string; original: string | null; creator: string | null }[];
}

export function createAttribution(): Attribution {
  const stored = new Map<string, { original: string | null; creator: string | null }>();
  return {
    remember(requestId, original, creator) {
      stored.set(requestId, { original: original ?? null, creator: creator ?? null });
    },
    replayRefusal(requestId, supplied) {
      const row = stored.get(requestId);
      if (!row || supplied === undefined || supplied === row.original) return null;
      if (row.original === null && supplied === row.creator) return null;
      return fail(409, 'IDEMPOTENCY_KEY_REUSED');
    },
    list: () => [...stored].map(([requestId, row]) => ({ requestId, ...row })),
  };
}
