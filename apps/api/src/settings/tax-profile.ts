/**
 * The owner's tax inputs for one Buddhist Era tax year (P7, D-34): extra allowances beyond the
 * personal one (which lives in the rules file) and the method preference. Read with `finance.pnl`
 * (owner only; cashiers may read settings but not this), saved with `settings.tax_profile` (owner,
 * step-up, audit). The whole profile of the year is replaced on each save.
 */
import { insertAudit, taxProfilesRepo } from '@sds/db';
import {
  type PutTaxProfileInput,
  type TaxProfileResponse,
  taxProfileValueSchema,
} from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { withTransaction } from '../tx.ts';

function toResponse(
  year: number,
  row: Awaited<ReturnType<typeof taxProfilesRepo.getTaxProfile>>,
): TaxProfileResponse {
  const value = row
    ? taxProfileValueSchema.parse({
        allowances: row.allowances,
        methodPreference: row.methodPreference,
      })
    : { allowances: { items: [] }, methodPreference: null };
  return { year, filerType: 'individual', ...value, saved: row !== undefined };
}

export async function readTaxProfile(ctx: AuthContext, year: number): Promise<TaxProfileResponse> {
  return toResponse(year, await taxProfilesRepo.getTaxProfile(ctx.db, year));
}

export async function putTaxProfile(
  ctx: AuthContext,
  actor: Principal,
  year: number,
  input: PutTaxProfileInput,
  meta: RequestMeta,
): Promise<TaxProfileResponse> {
  return withTransaction(ctx, async (tx) => {
    const row = await taxProfilesRepo.lockTaxProfile(tx, year);
    const before = toResponse(year, row);
    const next = taxProfileValueSchema.parse(input);
    if (
      row &&
      JSON.stringify({ a: before.allowances, m: before.methodPreference }) ===
        JSON.stringify({ a: next.allowances, m: next.methodPreference })
    ) {
      return before; // nothing changed: no write, no audit row
    }
    const saved = await taxProfilesRepo.putTaxProfile(tx, year, next);
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'settings.tax_profile_update',
      entity: 'tax_profiles',
      entityId: String(year),
      before: row
        ? { allowances: before.allowances, methodPreference: before.methodPreference }
        : null,
      after: next,
      ip: meta.ip,
    });
    return toResponse(year, saved);
  });
}
