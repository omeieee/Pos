/**
 * The platform commission form, outside React. The API keeps a rate in basis points (1 bp =
 * 0.01%); the owner reads and types a percent. The conversion is on the digits as text, never on a
 * float, like baht to satang. A blank field is "rate not set" (null): there is no built-in rate.
 */
import type { PlatformCommissionPatchInput, PlatformCommissionSettings } from '@sds/shared';

/** 2550 -> "25.5", 2500 -> "25", null -> "". */
export function bpToPercentText(bp: number | null): string {
  if (bp === null) return '';
  const fraction = bp % 100;
  const whole = (bp - fraction) / 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

export type ParsedPercent = { ok: true; bp: number | null } | { ok: false };

/** "25.5" -> 2550. Blank -> null (not set). 0 to 100, at most two decimals. */
export function parsePercentText(text: string): ParsedPercent {
  const body = text.trim();
  if (body === '') return { ok: true, bp: null };
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(body);
  if (!match) return { ok: false };
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp > 10000 ? { ok: false } : { ok: true, bp };
}

export interface CommissionForm {
  grab: string;
  lineman: string;
}
export type CommissionField = keyof CommissionForm;

export const commissionFormFrom = (value: PlatformCommissionSettings): CommissionForm => ({
  grab: bpToPercentText(value.grabRateBp),
  lineman: bpToPercentText(value.linemanRateBp),
});

export function validateCommissionForm(form: CommissionForm): CommissionField[] {
  return (['grab', 'lineman'] as const).filter((field) => !parsePercentText(form[field]).ok);
}

/** Only the rate(s) that changed, with the version the screen saw; null when nothing changed. */
export function buildCommissionPatch(
  saved: PlatformCommissionSettings,
  version: number,
  form: CommissionForm,
): PlatformCommissionPatchInput | null {
  const patch: {
    expectedVersion: number;
    grabRateBp?: number | null;
    linemanRateBp?: number | null;
  } = { expectedVersion: version };
  const grab = parsePercentText(form.grab);
  const lineman = parsePercentText(form.lineman);
  if (grab.ok && grab.bp !== saved.grabRateBp) patch.grabRateBp = grab.bp;
  if (lineman.ok && lineman.bp !== saved.linemanRateBp) patch.linemanRateBp = lineman.bp;
  return patch.grabRateBp === undefined && patch.linemanRateBp === undefined ? null : patch;
}
