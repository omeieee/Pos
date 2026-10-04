import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import * as invites from './invites.ts';
import * as people from './people.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let db: PgliteDb;
let client: PGlite;
let ownerId: string;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
  ownerId = (await newOwner()).staffId;
}, 60_000);
afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();
const at = new Date('2026-10-04T04:00:00Z');
const later = new Date('2026-10-07T04:00:00Z');

function newOwner() {
  return auth.insertOwner(db, {
    email: `${unique()}@example.test`,
    displayName: 'o',
    passwordHash: 'x',
    pinHash: null,
    encryptTotpSecret: () => 'enc',
    recoveryCodeHashes: [],
  });
}

const credentialed = (role: 'owner' | 'manager' | 'cashier' | 'kitchen' = 'cashier') =>
  auth.insertCredentialedStaff(db, {
    email: `${unique()}@example.test`,
    displayName: 'm',
    role,
    passwordHash: 'pw',
    pinHash: 'pin',
    encryptTotpSecret: () => 'enc',
    recoveryCodeHashes: [],
    totpLastStep: 1,
  });

const newInvite = (email = `${unique()}@example.test`, tokenHash = unique()) =>
  invites.insertInvite(db, {
    email,
    role: 'cashier',
    displayName: null,
    tokenHash,
    createdBy: ownerId,
    createdAt: at,
    expiresAt: later,
  });

describe('invites', () => {
  test('are listed open and without the token hash or the pending secret', async () => {
    const tokenHash = unique();
    const invite = await newInvite(undefined, tokenHash);
    await invites.setInvitePendingTotp(db, invite.id, 'enc-secret-value');
    const listed = (await invites.listOpenInvites(db)).find((i) => i.id === invite.id);
    expect(listed).toEqual(invite);
    expect(JSON.stringify(listed)).not.toContain(tokenHash);
    expect(JSON.stringify(listed)).not.toContain('enc-secret-value');
  });

  test('only one open invite per e-mail; a revoked or accepted one frees the e-mail', async () => {
    const email = `${unique()}@example.test`;
    const first = await newInvite(email);
    await expect(newInvite(email)).rejects.toMatchObject({ cause: { code: '23505' } });
    expect((await invites.lockOpenInviteByEmail(db, email))?.id).toBe(first.id);

    expect(await invites.revokeInvite(db, first.id, at)).toBe(true);
    expect(await invites.revokeInvite(db, first.id, at)).toBe(false); // already revoked
    expect(await invites.lockOpenInviteByEmail(db, email)).toBeUndefined();
    const second = await newInvite(email);
    expect(await invites.markInviteAccepted(db, second.id, at)).toBe(true);
    expect(await invites.markInviteAccepted(db, second.id, at)).toBe(false); // single use
    await newInvite(email); // free again
  });

  test('the e-mail must be stored lower case', async () => {
    await expect(newInvite('Mixed@Example.test')).rejects.toBeDefined();
  });

  test('a token hash finds one invite; accepting drops the pending secret', async () => {
    const tokenHash = unique();
    const invite = await newInvite(undefined, tokenHash);
    await invites.setInvitePendingTotp(db, invite.id, 'enc');
    await invites.setInviteFailures(db, invite.id, { failedAttempts: 2, revokedAt: null });
    const found = await invites.findInviteByTokenHash(db, tokenHash);
    expect(found).toMatchObject({
      id: invite.id,
      failedAttempts: 2,
      pendingTotpSecretEnc: 'enc',
      acceptedAt: null,
      revokedAt: null,
    });
    expect((await invites.lockInviteByTokenHash(db, tokenHash))?.id).toBe(invite.id);
    expect(await invites.findInviteByTokenHash(db, unique())).toBeUndefined();

    await invites.markInviteAccepted(db, invite.id, at);
    const accepted = await invites.lockInviteById(db, invite.id);
    expect(accepted).toMatchObject({ acceptedAt: at, pendingTotpSecretEnc: null });
    expect((await invites.listOpenInvites(db)).some((i) => i.id === invite.id)).toBe(false);
  });
});

describe('staff with credentials', () => {
  test('insertCredentialedStaff makes a staff row of any role with credentials and last TOTP step', async () => {
    const email = `${unique()}@example.test`;
    const { staffId } = await auth.insertCredentialedStaff(db, {
      email,
      displayName: 'manager',
      role: 'manager',
      passwordHash: 'pw',
      pinHash: 'pin',
      encryptTotpSecret: (id) => `enc-for-${id}`,
      recoveryCodeHashes: ['h1', 'h2'],
      totpLastStep: 12345,
    });
    expect(await auth.emailHasCredentials(db, email)).toBe(true);
    expect(await auth.emailHasCredentials(db, 'nobody@example.test')).toBe(false);
    const login = await auth.lockOwnerByEmail(db, email);
    expect(login).toMatchObject({
      staffId,
      role: 'manager',
      totpSecretEnc: `enc-for-${staffId}`,
      totpLastStep: 12345,
      recoveryCodeHashes: ['h1', 'h2'],
    });
    expect(await people.findStaff(db, staffId)).toMatchObject({
      role: 'manager',
      email,
      hasPin: true,
    });
    expect(await people.hasCredentials(db, staffId)).toBe(true);
  });

  test('countOwnerAccounts counts owners with an e-mail account only', async () => {
    const before = await auth.countOwnerAccounts(db);
    await newOwner();
    expect(await auth.countOwnerAccounts(db)).toBe(before + 1);
    await credentialed('manager');
    expect(await auth.countOwnerAccounts(db)).toBe(before + 1);
    await credentialed('owner');
    expect(await auth.countOwnerAccounts(db)).toBe(before + 2);
  });
});

describe('people: e-mail, role and owner locks', () => {
  test('the list and the locked row carry the e-mail; PIN-only staff have none', async () => {
    const pinOnly = await people.insertStaff(db, {
      displayName: 'pin only',
      role: 'cashier',
      pinHash: 'p',
    });
    expect(pinOnly.email).toBeNull();
    expect((await people.lockStaff(db, pinOnly.id))?.email).toBeNull();
    const owner = await newOwner();
    const listed = await people.listStaff(db);
    expect(listed.find((s) => s.id === owner.staffId)?.email).toMatch(/@example\.test$/);
    expect(listed.find((s) => s.id === pinOnly.id)?.email).toBeNull();
    expect((await people.lockStaff(db, owner.staffId))?.email).toMatch(/@example\.test$/);
  });

  test('updateStaffIfVersion changes the role under the version guard and keeps the e-mail', async () => {
    const created = await credentialed('cashier');
    const row = await people.lockStaff(db, created.staffId);
    expect(row).toBeDefined();
    expect(await people.updateStaffIfVersion(db, created.staffId, 99, { role: 'manager' })).toBe(
      undefined,
    );
    const updated = await people.updateStaffIfVersion(db, created.staffId, row?.version ?? 0, {
      role: 'manager',
    });
    expect(updated).toMatchObject({ role: 'manager', email: row?.email, version: 2 });
  });

  test('lockActiveOwners returns the active owners only, in id order', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const manager = await people.insertStaff(db, {
      displayName: 'm',
      role: 'manager',
      pinHash: 'p',
    });
    const gone = await newOwner();
    await people.updateStaffIfVersion(db, gone.staffId, 1, { active: false });
    const ids = await db.transaction((tx) => people.lockActiveOwners(tx));
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain(a.staffId);
    expect(ids).toContain(b.staffId);
    expect(ids).not.toContain(manager.id);
    expect(ids).not.toContain(gone.staffId);
  });
});
