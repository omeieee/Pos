/**
 * Operator commands on an owner account, run from a terminal on the VM (owner:reset,
 * owner:unlock). There is no HTTP route for either: the way in is shell access to the server.
 * With exactly one owner the commands act on it; with several (D-23) they need the owner's e-mail.
 */
import { authRepo, type Db, insertAudit } from '@sds/db';
import {
  type AuthKeys,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  verifyPassword,
} from './crypto.ts';
import { RECOVERY_CODE_COUNT } from './owner-setup.ts';

export class NoOwnerError extends Error {
  constructor() {
    super('no owner exists');
    this.name = 'NoOwnerError';
  }
}

/** Several owners exist and no e-mail was given. Carries the count only, never an address. */
export class MultipleOwnersError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`${count} owners exist; give --email`);
    this.name = 'MultipleOwnersError';
    this.count = count;
  }
}

interface AdminContext {
  db: Db;
  keys: AuthKeys;
  now: () => Date;
}

/**
 * The owner a command acts on, with the credentials row locked: the one with this e-mail, or the
 * only owner when no e-mail is given. An e-mail that is not an owner's answers like no owner.
 */
async function lockOwnerForCommand(tx: Db, email: string | undefined) {
  if (email !== undefined) {
    const owner = await authRepo.lockOwnerByEmail(tx, email.trim().toLowerCase());
    if (owner?.role !== 'owner') throw new NoOwnerError();
    return owner;
  }
  const count = await authRepo.countOwnerAccounts(tx);
  if (count > 1) throw new MultipleOwnersError(count);
  const owner = await authRepo.lockSoleOwner(tx);
  if (!owner) throw new NoOwnerError();
  return owner;
}

/** For the terminal commands: who they are about to act on (to show the e-mail before asking for proof). */
export async function findOwnerForCommand(ctx: Pick<AdminContext, 'db'>, email?: string) {
  return ctx.db.transaction((tx) => lockOwnerForCommand(tx, email));
}

/**
 * Checks the proof WITHOUT using it up, so the command can authenticate first and enrol the new
 * authenticator after. A refusal is audited.
 */
export async function verifyOwnerProof(
  ctx: Pick<AdminContext, 'db'>,
  proof: string,
  email?: string,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const owner = await lockOwnerForCommand(tx, email);
    const proven =
      (await verifyPassword(owner.passwordHash, proof)) ||
      owner.recoveryCodeHashes.includes(hashRecoveryCode(proof));
    if (!proven) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'owner.reset_refused',
        entity: 'staff',
        entityId: owner.staffId,
      });
    }
    return proven;
  });
}

/**
 * Replaces the owner's authenticator and recovery codes. The caller proves they are the owner
 * with the password or a valid recovery code (a recovery code works even when AUTH_SECRET_KEY was
 * lost, which is when this command is needed). The old secret and codes stop working and every
 * open owner session ends. Returns the new recovery codes once.
 */
export async function resetOwnerSecondFactor(
  ctx: AdminContext,
  input: { proof: string; newTotpSecret: Buffer; email?: string },
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false }> {
  const recoveryCodes = newRecoveryCodes(RECOVERY_CODE_COUNT);
  return ctx.db.transaction(async (tx) => {
    const owner = await lockOwnerForCommand(tx, input.email);

    const proven =
      (await verifyPassword(owner.passwordHash, input.proof)) ||
      (await authRepo.consumeRecoveryCode(tx, owner.staffId, hashRecoveryCode(input.proof)));
    if (!proven) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'owner.reset_refused',
        entity: 'staff',
        entityId: owner.staffId,
      });
      return { ok: false as const };
    }

    await authRepo.replaceOwnerSecondFactor(tx, owner.staffId, {
      totpSecretEnc: encryptSecret(input.newTotpSecret, ctx.keys.totpKey, owner.staffId),
      recoveryCodeHashes: recoveryCodes.map((code) => hashRecoveryCode(code)),
    });
    await authRepo.revokeSessionsForStaff(tx, owner.staffId, ctx.now());
    await insertAudit(tx, {
      actorType: 'system',
      action: 'owner.reset',
      entity: 'staff',
      entityId: owner.staffId,
      after: { recoveryCodes: recoveryCodes.length },
    });
    return { ok: true as const, recoveryCodes };
  });
}

/** Clears the owner's sign-in lock and failure count. */
export async function unlockOwner(ctx: Pick<AdminContext, 'db'>, email?: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const owner = await lockOwnerForCommand(tx, email);
    await authRepo.clearOwnerLocks(tx, owner.staffId);
    await insertAudit(tx, {
      actorType: 'system',
      action: 'owner.unlocked',
      entity: 'staff',
      entityId: owner.staffId,
    });
  });
}
