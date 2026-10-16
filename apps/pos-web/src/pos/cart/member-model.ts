/**
 * What staff see of the optional member details a customer gave (owner, 2026-10-11): who the order
 * is for. Pure. The phone number is for the people who hand over or collect money (cashier,
 * manager, owner): the kitchen role never gets it.
 */
import type { MemberProfile, StaffRole } from '@sds/shared';

export interface MemberView {
  /** Nickname first, then the full name, then the building; empty parts are left out. */
  who: string;
  phone: string | null;
}

const clean = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

export function memberView(
  member: MemberProfile | null | undefined,
  role: StaffRole | null | undefined,
): MemberView | null {
  if (!member) return null;
  const parts = [clean(member.nickname), clean(member.fullName), clean(member.building)].filter(
    (part): part is string => part !== null,
  );
  // Without a known role nobody is shown the number.
  const phone = role && role !== 'kitchen' ? clean(member.phone) : null;
  if (parts.length === 0 && phone === null) return null;
  return { who: parts.join(' · '), phone };
}
