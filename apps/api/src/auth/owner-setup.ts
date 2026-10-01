/**
 * Creates the first owner (D-17). Used by the `owner:create` command only: the API has no
 * route for it, so nobody can create an owner over the network.
 *
 * Only hashes are stored: the password, the optional PIN and the recovery codes. The TOTP
 * secret is stored encrypted (AES-256-GCM, bound to the staff id). The caller shows the
 * secret and the recovery codes to the owner once and keeps nothing.
 */
import { authRepo, type Db, insertAudit } from '@sds/db';
import { ownerPasswordSchema, pinSchema } from '@sds/shared';
import { z } from 'zod';
import { parse } from '../validate.ts';
import {
  type AuthKeys,
  encryptSecret,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  newRecoveryCodes,
} from './crypto.ts';

export const RECOVERY_CODE_COUNT = 8;

export class OwnerExistsError extends Error {
  constructor() {
    super('an owner already exists');
    this.name = 'OwnerExistsError';
  }
}

const newOwnerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  displayName: z.string().trim().min(1).max(60),
  password: ownerPasswordSchema,
  pin: pinSchema.optional(),
});

export interface NewOwnerInput {
  email: string;
  displayName: string;
  password: string;
  /** Optional daily PIN for the owner's own devices. */
  pin?: string | undefined;
  /** The raw TOTP secret the owner has already enrolled in an authenticator app. */
  totpSecret: Buffer;
}

export async function createOwner(
  ctx: { db: Db; keys: AuthKeys },
  input: NewOwnerInput,
): Promise<{ staffId: string; recoveryCodes: string[] }> {
  const owner = parse(newOwnerSchema, input);
  const recoveryCodes = newRecoveryCodes(RECOVERY_CODE_COUNT);
  // Hash before opening the transaction: scrypt is slow and needs no database.
  const passwordHash = await hashPassword(owner.password);
  const pinHash = owner.pin === undefined ? null : await hashPin(owner.pin, ctx.keys);

  const staffId = await ctx.db.transaction(async (tx) => {
    if (await authRepo.ownerExists(tx)) throw new OwnerExistsError();
    const created = await authRepo.insertOwner(tx, {
      email: owner.email,
      displayName: owner.displayName,
      passwordHash,
      pinHash,
      encryptTotpSecret: (id) => encryptSecret(input.totpSecret, ctx.keys.totpKey, id),
      recoveryCodeHashes: recoveryCodes.map((code) => hashRecoveryCode(code)),
    });
    await insertAudit(tx, {
      actorType: 'system',
      action: 'owner.created',
      entity: 'staff',
      entityId: created.staffId,
    });
    return created.staffId;
  });
  return { staffId, recoveryCodes };
}
