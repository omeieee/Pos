/**
 * The invitee's side of an e-mail invite (D-23): preview the link (which hands out a fresh
 * authenticator secret) and accept it (password, PIN, a code from the authenticator). Both are
 * public: the unguessable token is the credential. A token that is unknown, expired, used or
 * revoked gets the one generic INVITE_INVALID answer.
 *
 * Accepting creates the person with the invite's role (never the body's), their credentials, PIN
 * hash and recovery codes in one transaction. The authenticator secret is the one stored at
 * preview, never one sent by the client. Wrong codes are counted on the invite; at
 * `policy.inviteMaxFailures` the invite is revoked.
 */
import { authRepo, insertAudit, invitesRepo } from '@sds/db';
import {
  type AcceptInviteInput,
  type AcceptInviteResponse,
  type InvitePreviewInput,
  type InvitePreviewResponse,
  pinSchemaFor,
} from '@sds/shared';
import { z } from 'zod';
import { ApiError, conflict, inviteInvalid } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  hashToken,
  newRecoveryCodes,
} from './crypto.ts';
import { RECOVERY_CODE_COUNT } from './owner-setup.ts';
import { type AuthContext, type RequestMeta, securityAlert } from './service.ts';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

const ISSUER = 'Saap Don Sen POS';

const usable = (row: invitesRepo.InviteStateRow, now: Date) =>
  row.acceptedAt === null && row.revokedAt === null && row.expiresAt > now;

/** The code did not match the authenticator secret of this invite. Not a sign-in: no 401. */
const codeInvalid = () =>
  new ApiError(
    422,
    'INVITE_CODE_INVALID',
    'That authenticator code is not right. Try the next one',
  );

const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === '23505';

/**
 * Shows the invitee who they are invited as and the authenticator secret of this invite: made at
 * the first preview and shown again by every later one.
 */
export async function previewInvite(
  ctx: AuthContext,
  input: InvitePreviewInput,
): Promise<InvitePreviewResponse> {
  const tokenHash = hashToken(input.token);
  const fresh = generateTotpSecret();
  const shown = await withTransaction(ctx, async (tx) => {
    const found = await invitesRepo.lockInviteByTokenHash(tx, tokenHash);
    if (!found || !usable(found, ctx.now())) return null;
    // A repeat preview (a second tab or browser) shows the same secret, so tabs do not break each
    // other. A stored secret that cannot be read (the key changed) is replaced.
    if (found.pendingTotpSecretEnc) {
      try {
        return {
          row: found,
          secret: decryptSecret(found.pendingTotpSecretEnc, ctx.keys.totpKey, found.id),
        };
      } catch {
        // fall through and store a new one
      }
    }
    await invitesRepo.setInvitePendingTotp(
      tx,
      found.id,
      encryptSecret(fresh, ctx.keys.totpKey, found.id),
    );
    return { row: found, secret: fresh };
  });
  if (!shown) throw inviteInvalid();
  const { row, secret } = shown;
  return {
    email: row.email,
    role: row.role,
    displayName: row.displayName,
    totp: {
      secretBase32: base32Encode(secret),
      otpauthUri: otpauthUri({ secret, account: row.email, issuer: ISSUER }),
    },
  };
}

type AcceptOutcome =
  | { kind: 'invalid' }
  | { kind: 'code_invalid' }
  | { kind: 'accepted'; recoveryCodes: string[] };

export async function acceptInvite(
  ctx: AuthContext,
  input: AcceptInviteInput,
  meta: RequestMeta,
): Promise<AcceptInviteResponse> {
  const tokenHash = hashToken(input.token);
  // A random token costs one lookup and nothing else: no hashing until the invite is real.
  const first = await invitesRepo.findInviteByTokenHash(ctx.db, tokenHash);
  if (!first || !usable(first, ctx.now())) throw inviteInvalid();
  // The role is the invite's: a 400 on `pin` when it is too short for that role.
  parse(z.object({ pin: pinSchemaFor(first.role) }), { pin: input.pin });

  // Slow hashes run before the transaction, so nothing waits on scrypt while holding a lock.
  const [passwordHash, pinHash] = await Promise.all([
    hashPassword(input.password),
    hashPin(input.pin, ctx.keys),
  ]);
  const recoveryCodes = newRecoveryCodes(RECOVERY_CODE_COUNT);

  let outcome: AcceptOutcome;
  try {
    outcome = await withTransaction(ctx, async (tx, emit): Promise<AcceptOutcome> => {
      const row = await invitesRepo.lockInviteByTokenHash(tx, tokenHash);
      const now = ctx.now();
      if (!row || !usable(row, now)) return { kind: 'invalid' };

      // Only the secret stored at preview counts; nothing the client sends is trusted for it.
      let secret: Buffer | null = null;
      let step: number | null = null;
      if (row.pendingTotpSecretEnc) {
        try {
          secret = decryptSecret(row.pendingTotpSecretEnc, ctx.keys.totpKey, row.id);
          const matched = verifyTotp(secret, input.totpCode, now.getTime());
          if (matched.ok) step = matched.step;
        } catch {
          secret = null; // unreadable (the key changed): the invitee previews again
        }
      }
      if (secret === null || step === null) {
        const failures = row.failedAttempts + 1;
        const locks = failures >= ctx.policy.inviteMaxFailures;
        await invitesRepo.setInviteFailures(tx, row.id, {
          failedAttempts: failures,
          revokedAt: locks ? now : null,
        });
        await insertAudit(tx, {
          actorType: 'system',
          action: locks ? 'staff.invite_locked' : 'staff.invite_code_failed',
          entity: 'staff_invites',
          entityId: row.id,
          after: { failedAttempts: failures },
          ip: meta.ip,
        });
        if (locks) emit(securityAlert(ctx, 'staff.invite_locked', 'warn', {}));
        return { kind: 'code_invalid' };
      }

      const keepSecret = secret;
      const created = await authRepo.insertCredentialedStaff(tx, {
        email: row.email,
        displayName: input.displayName,
        role: row.role,
        passwordHash,
        pinHash,
        encryptTotpSecret: (staffId) => encryptSecret(keepSecret, ctx.keys.totpKey, staffId),
        recoveryCodeHashes: recoveryCodes.map((code) => hashRecoveryCode(code)),
        totpLastStep: step, // the code used here cannot sign them in a second time
      });
      await invitesRepo.markInviteAccepted(tx, row.id, now);
      await insertAudit(tx, {
        actorType: 'system',
        action: 'staff.invite_accepted',
        entity: 'staff',
        entityId: created.staffId,
        after: { role: row.role, inviteId: row.id },
        ip: meta.ip,
      });
      emit(securityAlert(ctx, 'staff.invite_accepted', 'warn', { staffId: created.staffId }));
      return { kind: 'accepted', recoveryCodes };
    });
  } catch (error) {
    // The e-mail got an account some other way after the invite was made.
    if (isUniqueViolation(error))
      throw conflict('EMAIL_TAKEN', 'This e-mail already has an account');
    throw error;
  }
  if (outcome.kind === 'invalid') throw inviteInvalid();
  if (outcome.kind === 'code_invalid') throw codeInvalid();
  return { recoveryCodes: outcome.recoveryCodes };
}
