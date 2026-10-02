/**
 * The rules of the ไทยช่วยไทย scheme form, outside React. The owner types the scheme (its share,
 * caps, dates and hours): nothing about it is assumed here, and nothing in this file is a scheme
 * rule: whether co-pay may be offered right now is decided by the shared `isCopayAvailable`, and
 * the server checks the whole scheme again before saving.
 *
 * The channels are not on the form. A scheme is created for the storefront only (face-to-face
 * payment, CLAUDE.md rule 4), an existing scheme keeps the channels it has, and a save never sends
 * them. A new scheme is OFF until the owner switches it on.
 */
import { type GovCopayDto, type GovCopayPatchInput, isoDateSchema, satang } from '@sds/shared';
import { parseBahtText, satangToText } from '../menu-editor/model.ts';
import { minutesToText, parseTimeText } from './model.ts';

// ---------- Percent text ----------

/**
 * "60" or "60.55" as basis points (6000, 6055), read as text so no float is involved. 0 to 100,
 * at most two decimals; anything else is null.
 */
export function parsePercentText(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const basisPoints = whole * 100 + fraction;
  return basisPoints > 10000 ? null : basisPoints;
}

/** Basis points as percent text: 6000 -> "60", 6050 -> "60.5", 1 -> "0.01". */
export function basisPointsToPercentText(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return fraction === '00' || fraction === '0' || fraction === ''
    ? String(whole)
    : `${whole}.${fraction}`;
}

// ---------- The form ----------

export interface CopayForm {
  nameTh: string;
  nameEn: string;
  /** The government's share, in percent. */
  share: string;
  /** In baht; empty = no cap on file. */
  dailyCap: string;
  totalCap: string;
  /** First and last day, `YYYY-MM-DD`. */
  activeFrom: string;
  activeTo: string;
  /** Daily hours as times; the end may be 24:00. */
  fromTime: string;
  toTime: string;
  enabled: boolean;
}
export type CopayField =
  | 'nameTh'
  | 'share'
  | 'dailyCap'
  | 'totalCap'
  | 'activeFrom'
  | 'activeTo'
  | 'fromTime'
  | 'toTime'
  | 'enabled';

/** A saved scheme as form text; with none, an empty form that is OFF. */
export function copayFormFrom(scheme: GovCopayDto | null): CopayForm {
  if (!scheme) {
    return {
      nameTh: '',
      nameEn: '',
      share: '',
      dailyCap: '',
      totalCap: '',
      activeFrom: '',
      activeTo: '',
      fromTime: '',
      toTime: '',
      enabled: false,
    };
  }
  return {
    nameTh: scheme.nameTh,
    nameEn: scheme.nameEn ?? '',
    share: basisPointsToPercentText(scheme.govShareBp),
    dailyCap: scheme.govDailyCapSatang === null ? '' : satangToText(scheme.govDailyCapSatang),
    totalCap: scheme.govTotalCapSatang === null ? '' : satangToText(scheme.govTotalCapSatang),
    activeFrom: scheme.activeFrom,
    activeTo: scheme.activeTo,
    fromTime: minutesToText(scheme.activeFromMinute),
    toTime: minutesToText(scheme.activeToMinute),
    enabled: scheme.enabled,
  };
}

const isDate = (text: string) => isoDateSchema.safeParse(text.trim()).success;

/** An empty cap box is "no cap"; otherwise baht text, exactly, never negative. */
function readCap(text: string): { ok: true; satang: number | null } | { ok: false } {
  if (text.trim() === '') return { ok: true, satang: null };
  const parsed = parseBahtText(text);
  return parsed.ok ? { ok: true, satang: parsed.satang } : { ok: false };
}

/**
 * What is wrong with the form. `channels` is how many channels the saved scheme has (a new one is
 * given the storefront): the server refuses to turn a scheme on with none.
 */
export function validateCopayForm(form: CopayForm, scheme: { channels: number }): CopayField[] {
  const errors: CopayField[] = [];
  if (form.nameTh.trim() === '' || form.nameTh.trim().length > 80) errors.push('nameTh');

  const share = parsePercentText(form.share);
  if (share === null || (form.enabled && share <= 0)) errors.push('share');
  if (!readCap(form.dailyCap).ok) errors.push('dailyCap');
  if (!readCap(form.totalCap).ok) errors.push('totalCap');

  const fromOk = isDate(form.activeFrom);
  const toOk = isDate(form.activeTo);
  if (!fromOk) errors.push('activeFrom');
  if (!toOk || (fromOk && form.activeFrom.trim() > form.activeTo.trim())) errors.push('activeTo');

  const from = parseTimeText(form.fromTime);
  const to = parseTimeText(form.toTime, { allowMidnight: true });
  if (from === null) errors.push('fromTime');
  if (to === null || (from !== null && from >= to)) errors.push('toTime');

  if (form.enabled && scheme.channels === 0) errors.push('enabled');
  return errors;
}

const nullable = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/**
 * The save for a validated form. With a saved scheme: only what changed, with its version, and
 * never the channels; null when nothing changed. With none: the whole scheme at version 0, for the
 * storefront only.
 */
export function buildCopayInput(
  base: GovCopayDto | null,
  version: number,
  form: CopayForm,
): GovCopayPatchInput | null {
  const share = parsePercentText(form.share);
  const daily = readCap(form.dailyCap);
  const total = readCap(form.totalCap);
  const from = parseTimeText(form.fromTime);
  const to = parseTimeText(form.toTime, { allowMidnight: true });
  if (share === null || !daily.ok || !total.ok || from === null || to === null) return null;

  const fields = {
    govShareBp: share,
    govDailyCapSatang: daily.satang === null ? null : satang(daily.satang),
    govTotalCapSatang: total.satang === null ? null : satang(total.satang),
    activeFrom: form.activeFrom.trim(),
    activeTo: form.activeTo.trim(),
    activeFromMinute: from,
    activeToMinute: to,
    enabled: form.enabled,
  };

  if (base === null) {
    const nameEn = nullable(form.nameEn);
    return {
      expectedVersion: version,
      nameTh: form.nameTh.trim(),
      ...(nameEn === null ? {} : { nameEn }),
      ...fields,
      channels: ['storefront'],
    };
  }

  const patch: Omit<GovCopayPatchInput, 'expectedVersion'> = {};
  if (form.nameTh.trim() !== base.nameTh) patch.nameTh = form.nameTh.trim();
  if (nullable(form.nameEn) !== base.nameEn) patch.nameEn = nullable(form.nameEn);
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (fields[key] !== base[key]) Object.assign(patch, { [key]: fields[key] });
  }
  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}
