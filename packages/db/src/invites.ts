/**
 * Queries for e-mail invites (D-23). Reads for the owner's list never select the token hash or
 * the pending authenticator secret. apps/api decides who may call them and compares every
 * timestamp with its own clock.
 */
import type { StaffRole } from '@sds/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from './client.ts';
import { staffInvites } from './schema.ts';

export interface InviteListRow {
  id: string;
  email: string;
  role: StaffRole;
  displayName: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** What accepting needs to know about one invite, found by the hash of its token. */
export interface InviteStateRow extends InviteListRow {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  failedAttempts: number;
  pendingTotpSecretEnc: string | null;
}

const listColumns = {
  id: staffInvites.id,
  email: staffInvites.email,
  role: staffInvites.role,
  displayName: staffInvites.displayName,
  createdAt: staffInvites.createdAt,
  expiresAt: staffInvites.expiresAt,
};

const stateColumns = {
  ...listColumns,
  acceptedAt: staffInvites.acceptedAt,
  revokedAt: staffInvites.revokedAt,
  failedAttempts: staffInvites.failedAttempts,
  pendingTotpSecretEnc: staffInvites.pendingTotpSecretEnc,
};

const open = and(isNull(staffInvites.acceptedAt), isNull(staffInvites.revokedAt));

/** Invites that were neither accepted nor revoked (expired ones included), newest first. */
export async function listOpenInvites(db: Db): Promise<InviteListRow[]> {
  const rows = await db
    .select(listColumns)
    .from(staffInvites)
    .where(open)
    .orderBy(desc(staffInvites.createdAt), desc(staffInvites.id));
  return rows as InviteListRow[];
}

/** The not-accepted, not-revoked invite for an e-mail, with its row locked. At most one exists. */
export async function lockOpenInviteByEmail(
  db: Db,
  email: string,
): Promise<InviteListRow | undefined> {
  const [row] = await db
    .select(listColumns)
    .from(staffInvites)
    .where(and(eq(staffInvites.email, email), open))
    .for('update')
    .limit(1);
  return row as InviteListRow | undefined;
}

export async function insertInvite(
  db: Db,
  input: {
    email: string;
    role: StaffRole;
    displayName: string | null;
    tokenHash: string;
    createdBy: string;
    /** The caller's clock, so created and expiry times come from the same source. */
    createdAt: Date;
    expiresAt: Date;
  },
): Promise<InviteListRow> {
  const [row] = await db.insert(staffInvites).values(input).returning(listColumns);
  if (!row) throw new Error('invite insert returned no row');
  return row as InviteListRow;
}

export async function lockInviteById(db: Db, id: string): Promise<InviteStateRow | undefined> {
  const [row] = await db
    .select(stateColumns)
    .from(staffInvites)
    .where(eq(staffInvites.id, id))
    .for('update')
    .limit(1);
  return row as InviteStateRow | undefined;
}

/** No lock: for the cheap first look that decides whether a request is worth any hashing. */
export async function findInviteByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<InviteStateRow | undefined> {
  const [row] = await db
    .select(stateColumns)
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .limit(1);
  return row as InviteStateRow | undefined;
}

/** Locks the invite for the rest of the transaction, so parallel accepts are counted one by one. */
export async function lockInviteByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<InviteStateRow | undefined> {
  const [row] = await db
    .select(stateColumns)
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .for('update')
    .limit(1);
  return row as InviteStateRow | undefined;
}

/** Stores the authenticator secret shown at preview (already encrypted by the caller). */
export async function setInvitePendingTotp(db: Db, id: string, enc: string): Promise<void> {
  await db.update(staffInvites).set({ pendingTotpSecretEnc: enc }).where(eq(staffInvites.id, id));
}

/** Counts a wrong authenticator code; `revokedAt` ends the invite when the limit is reached. */
export async function setInviteFailures(
  db: Db,
  id: string,
  state: { failedAttempts: number; revokedAt: Date | null },
): Promise<void> {
  await db.update(staffInvites).set(state).where(eq(staffInvites.id, id));
}

/** One conditional UPDATE: false when the invite was already accepted or revoked. */
export async function revokeInvite(db: Db, id: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(staffInvites)
    .set({ revokedAt: at })
    .where(and(eq(staffInvites.id, id), open))
    .returning({ id: staffInvites.id });
  return rows.length === 1;
}

/** Marks the invite used and drops the pending secret (it now lives encrypted on the account). */
export async function markInviteAccepted(db: Db, id: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(staffInvites)
    .set({ acceptedAt: at, pendingTotpSecretEnc: null })
    .where(and(eq(staffInvites.id, id), open))
    .returning({ id: staffInvites.id });
  return rows.length === 1;
}
