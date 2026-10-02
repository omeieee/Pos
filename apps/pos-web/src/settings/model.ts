/**
 * The rules of the settings forms, outside React: what a form's text means (times as minutes from
 * midnight, blank optional text as none), what a save sends, and how lists change. A save sends
 * only the fields that changed, with the version the person saw (`expectedVersion`). No component
 * does arithmetic or checks a rule: the shared schemas decide what is valid, the server checks
 * again.
 */
import {
  type BusinessDaySettings,
  buildingNameSchema,
  type DayWindow,
  type DeliveryPatchInput,
  type DeliverySettings,
  isoDateSchema,
  MAX_DELIVERY_BUILDINGS,
  type NumberingPatchInput,
  type OpeningHours,
  type OpeningHoursPatchInput,
  type PaymentsPatchInput,
  type PaymentsSettings,
  type ShopPatchInput,
  type ShopSettings,
  WEEKDAYS,
  type Weekday,
} from '@sds/shared';

// ---------- Time text ----------

/**
 * "11:00" or "9:05" as minutes from midnight; null when it is not a time. "24:00" (midnight at the
 * end of the day) only where a closing time may be (`allowMidnight`).
 */
export function parseTimeText(
  text: string,
  options: { allowMidnight?: boolean } = {},
): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24) return options.allowMidnight && minutes === 0 ? 1440 : null;
  return hours > 23 ? null : hours * 60 + minutes;
}

/** Minutes from midnight as "HH:MM" (1440 is "24:00"). */
export function minutesToText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** An optional text field: trimmed, empty means "none" (null). */
const nullable = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** Key order does not matter when two values are compared. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

// ---------- Shop details ----------

export interface ShopForm {
  nameTh: string;
  nameEn: string;
  phone: string;
  address: string;
}
export type ShopField = keyof ShopForm;

export const shopFormFrom = (shop: ShopSettings): ShopForm => ({
  nameTh: shop.nameTh,
  nameEn: shop.nameEn ?? '',
  phone: shop.phone ?? '',
  address: shop.address ?? '',
});

const SHOP_MAX: Record<ShopField, number> = { nameTh: 80, nameEn: 80, phone: 30, address: 200 };

export function validateShopForm(form: ShopForm): ShopField[] {
  const errors: ShopField[] = [];
  if (form.nameTh.trim() === '') errors.push('nameTh');
  for (const field of Object.keys(SHOP_MAX) as ShopField[]) {
    if (form[field].trim().length > SHOP_MAX[field] && !errors.includes(field)) errors.push(field);
  }
  return errors;
}

/** The patch for a validated form against the saved shop; null when nothing changed. */
export function buildShopPatch(
  base: ShopSettings,
  version: number,
  form: ShopForm,
): ShopPatchInput | null {
  const patch: Omit<ShopPatchInput, 'expectedVersion'> = {};
  if (form.nameTh.trim() !== base.nameTh) patch.nameTh = form.nameTh.trim();
  if (nullable(form.nameEn) !== base.nameEn) patch.nameEn = nullable(form.nameEn);
  if (nullable(form.phone) !== base.phone) patch.phone = nullable(form.phone);
  if (nullable(form.address) !== base.address) patch.address = nullable(form.address);
  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}

// ---------- Opening hours ----------

export interface WindowForm {
  open: string;
  close: string;
}

export interface ClosureForm {
  date: string;
  note: string;
}

export interface HoursForm {
  storefront: WindowForm;
  delivery: WindowForm;
  /** A weekday closed for both services. */
  closedDays: Record<Weekday, boolean>;
  /** Dates closed all day. Dates with their own hours are kept as they are and not shown here. */
  closures: ClosureForm[];
}

export type HoursField = 'storefront' | 'delivery' | 'closures' | `closure:${number}`;

const windowForm = (w: DayWindow): WindowForm => ({
  open: minutesToText(w.openMinute),
  close: minutesToText(w.closeMinute),
});

const isClosedDay = (rule: OpeningHours['weekly'][Weekday]): boolean =>
  rule?.storefront === null && rule?.delivery === null;

export function hoursFormFrom(hours: OpeningHours): HoursForm {
  return {
    storefront: windowForm(hours.storefront),
    delivery: windowForm(hours.delivery),
    closedDays: Object.fromEntries(
      WEEKDAYS.map((day) => [day, isClosedDay(hours.weekly[day])]),
    ) as Record<Weekday, boolean>,
    closures: hours.overrides
      .filter((o) => o.closed)
      .map((o) => ({ date: o.date, note: o.note ?? '' })),
  };
}

/** Does the saved value hold weekday rules or dated hours that this form keeps but does not show? */
export function hasOtherHoursRules(hours: OpeningHours): boolean {
  const otherWeekday = WEEKDAYS.some((day) => {
    const rule = hours.weekly[day];
    return rule !== undefined && !isClosedDay(rule);
  });
  return otherWeekday || hours.overrides.some((o) => !o.closed);
}

/** A window as typed, or null when it is not a real one (open before close, both real times). */
function readWindow(form: WindowForm): DayWindow | null {
  const openMinute = parseTimeText(form.open);
  const closeMinute = parseTimeText(form.close, { allowMidnight: true });
  if (openMinute === null || closeMinute === null || openMinute >= closeMinute) return null;
  return { openMinute, closeMinute };
}

const MAX_OVERRIDES = 400;

export function validateHoursForm(base: OpeningHours, form: HoursForm): HoursField[] {
  const errors: HoursField[] = [];
  if (readWindow(form.storefront) === null) errors.push('storefront');
  if (readWindow(form.delivery) === null) errors.push('delivery');
  const withOwnHours = new Set(base.overrides.filter((o) => !o.closed).map((o) => o.date));
  const seen = new Set<string>();
  form.closures.forEach((closure, index) => {
    const date = closure.date.trim();
    if (!isoDateSchema.safeParse(date).success || seen.has(date) || withOwnHours.has(date)) {
      errors.push(`closure:${index}`);
    }
    seen.add(date);
  });
  if (withOwnHours.size + form.closures.length > MAX_OVERRIDES) errors.push('closures');
  return errors;
}

type Override = OpeningHours['overrides'][number];

const closedOverride = (closure: ClosureForm): Override => ({
  date: closure.date.trim(),
  closed: true,
  ...(closure.note.trim() === '' ? {} : { note: closure.note.trim() }),
});

/**
 * The patch for a validated form against the saved hours; null when nothing changed. `weekly` and
 * `overrides` are replaced whole by the server, so a change to either is built from everything the
 * saved value holds: weekday rules and dated overrides this form does not show are kept as they are.
 */
export function buildHoursPatch(
  base: OpeningHours,
  version: number,
  form: HoursForm,
): OpeningHoursPatchInput | null {
  const patch: Omit<OpeningHoursPatchInput, 'expectedVersion'> = {};

  const storefront = readWindow(form.storefront);
  if (storefront && !same(storefront, base.storefront)) patch.storefront = storefront;
  const delivery = readWindow(form.delivery);
  if (delivery && !same(delivery, base.delivery)) patch.delivery = delivery;

  const weekly: OpeningHours['weekly'] = { ...base.weekly };
  for (const day of WEEKDAYS) {
    const wasClosed = isClosedDay(base.weekly[day]);
    if (form.closedDays[day] && !wasClosed) {
      weekly[day] = { ...base.weekly[day], storefront: null, delivery: null };
    } else if (!form.closedDays[day] && wasClosed) {
      delete weekly[day];
    }
  }
  if (!same(weekly, base.weekly)) patch.weekly = weekly;

  const overrides: Override[] = [];
  for (const override of base.overrides) {
    if (!override.closed) {
      overrides.push(override);
      continue;
    }
    const still = form.closures.find((c) => c.date.trim() === override.date);
    if (still) overrides.push(closedOverride(still));
  }
  for (const closure of form.closures) {
    if (!base.overrides.some((o) => o.date === closure.date.trim())) {
      overrides.push(closedOverride(closure));
    }
  }
  if (!same(overrides, base.overrides)) patch.overrides = overrides;

  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}

// ---------- Business day and numbering ----------

export interface NumberingForm {
  cutoff: string;
}

export const numberingFormFrom = (settings: BusinessDaySettings): NumberingForm => ({
  cutoff: minutesToText(settings.cutoffMinutes),
});

export function validateNumberingForm(form: NumberingForm): 'cutoff'[] {
  return parseTimeText(form.cutoff) === null ? ['cutoff'] : [];
}

export function buildNumberingPatch(
  base: BusinessDaySettings,
  version: number,
  form: NumberingForm,
): NumberingPatchInput | null {
  const cutoffMinutes = parseTimeText(form.cutoff);
  if (cutoffMinutes === null || cutoffMinutes === base.cutoffMinutes) return null;
  return { expectedVersion: version, cutoffMinutes };
}

// ---------- Payment methods ----------

export function buildPaymentsPatch(
  base: PaymentsSettings,
  version: number,
  form: PaymentsSettings,
): PaymentsPatchInput | null {
  const patch: Omit<PaymentsPatchInput, 'expectedVersion'> = {};
  for (const method of ['cash', 'promptpay', 'platform', 'other'] as const) {
    if (form[method] !== base[method]) patch[method] = form[method];
  }
  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}

// ---------- Delivery buildings ----------

export type BuildingError = 'empty' | 'tooLong' | 'duplicate' | 'full' | 'last';
export type BuildingChange = { ok: true; list: string[] } | { ok: false; error: BuildingError };

export function addBuilding(list: readonly string[], text: string): BuildingChange {
  if (text.trim() === '') return { ok: false, error: 'empty' };
  const name = buildingNameSchema.safeParse(text);
  if (!name.success) return { ok: false, error: 'tooLong' };
  if (list.some((b) => b.toLowerCase() === name.data.toLowerCase())) {
    return { ok: false, error: 'duplicate' };
  }
  if (list.length >= MAX_DELIVERY_BUILDINGS) return { ok: false, error: 'full' };
  return { ok: true, list: [...list, name.data] };
}

/** An order must name a building, so the list never goes empty. */
export function removeBuilding(list: readonly string[], name: string): BuildingChange {
  if (list.length <= 1) return { ok: false, error: 'last' };
  return { ok: true, list: list.filter((b) => b !== name) };
}

export function buildDeliveryInput(
  base: DeliverySettings,
  version: number,
  list: readonly string[],
): DeliveryPatchInput | null {
  if (same(base.buildings, list)) return null;
  return { expectedVersion: version, buildings: [...list] };
}
