/**
 * The owner's side of e-mail invites (D-23): list, create, revoke. Owner only with step-up (the
 * route guard checks); every change is audited and alerted. The link's token is returned once and
 * only its hash is stored; the audit log and alerts never hold the token or the e-mail.
 */
import { authRepo, type Db, insertAudit, invitesRepo, peopleRepo } from '@sds/db';
import type {
  CreateInviteInput,
  CreateInviteResponse,
  InviteDto,
  ListInvitesResponse,
} from '@sds/shared';
import { hashToken, newToken } from '../auth/crypto.ts';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { withTransaction } from '../tx.ts';

const audited = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});

/** The guard read the actor before this transaction; they may have lost the owner role since. */
async function requireActiveOwner(tx: Db, actor: Principal): Promise<void> {
  const owners = await peopleRepo.lockActiveOwners(tx);
  if (!owners.includes(actor.staffId)) throw forbidden();
}

function toInviteDto(ctx: Pick<AuthContext, 'now'>, row: invitesRepo.InviteListRow): InviteDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.expiresAt > ctx.now() ? 'open' : 'expired',
  };
}

/** Invites that were neither accepted nor revoked; an expired one shows until it is revoked or replaced. */
export async function listInvites(ctx: AuthContext): Promise<ListInvitesResponse> {
  return { invites: (await invitesRepo.listOpenInvites(ctx.db)).map((r) => toInviteDto(ctx, r)) };
}

const isUniqueViolation = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code === '23505';

const inviteExists = () =>
  conflict('INVITE_EXISTS', 'This e-mail already has an open invite. Revoke it to make a new one');

/**
 * 409 EMAIL_TAKEN when the e-mail already signs somebody in, 409 INVITE_EXISTS while a still-valid
 * invite is open. An expired open invite is revoked in the same transaction, so it does not block
 * the e-mail for good. The partial unique index settles two creates racing.
 */
export async function createInvite(
  ctx: AuthContext,
  actor: Principal,
  input: CreateInviteInput,
  meta: RequestMeta,
): Promise<CreateInviteResponse> {
  const token = newToken('sds_inv');
  try {
    return await withTransaction(ctx, async (tx, emit) => {
      await requireActiveOwner(tx, actor);
      if (await authRepo.emailHasCredentials(tx, input.email)) {
        throw conflict('EMAIL_TAKEN', 'This e-mail already has an account');
      }
      const now = ctx.now();
      const open = await invitesRepo.lockOpenInviteByEmail(tx, input.email);
      if (open) {
        if (open.expiresAt > now) throw inviteExists();
        await invitesRepo.revokeInvite(tx, open.id, now);
        await insertAudit(tx, {
          ...audited(actor, meta),
          action: 'staff.invite_revoke',
          entity: 'staff_invites',
          entityId: open.id,
          after: { reason: 'expired_and_replaced' },
        });
      }
      const row = await invitesRepo.insertInvite(tx, {
        email: input.email,
        role: input.role,
        displayName: input.displayName ?? null,
        tokenHash: hashToken(token),
        createdBy: actor.staffId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ctx.policy.inviteSeconds * 1000),
      });
      await insertAudit(tx, {
        ...audited(actor, meta),
        action: 'staff.invite_create',
        entity: 'staff_invites',
        entityId: row.id,
        after: { role: row.role, expiresAt: row.expiresAt.toISOString() },
      });
      emit(
        securityAlert(ctx, 'staff.invited', 'warn', {
          staffId: actor.staffId,
          deviceId: actor.deviceId,
        }),
      );
      return { ...toInviteDto(ctx, row), token };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw inviteExists();
    throw error;
  }
}

/** Ends an open invite so its link stops working. Revoking twice changes nothing; an accepted one cannot be revoked. */
export async function revokeInvite(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<void> {
  await withTransaction(ctx, async (tx, emit) => {
    await requireActiveOwner(tx, actor);
    const row = await invitesRepo.lockInviteById(tx, id);
    if (!row) throw notFound('Invite');
    if (row.acceptedAt) throw conflict('INVITE_ACCEPTED', 'This invite was already accepted');
    if (row.revokedAt) return;
    await invitesRepo.revokeInvite(tx, id, ctx.now());
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'staff.invite_revoke',
      entity: 'staff_invites',
      entityId: id,
      after: { reason: 'owner' },
    });
    emit(
      securityAlert(ctx, 'staff.invite_revoked', 'warn', {
        staffId: actor.staffId,
        deviceId: actor.deviceId,
      }),
    );
  });
}
