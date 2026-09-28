/**
 * Money in integer satang, THB only (D-11). The server computes totals; UIs only format.
 * Satang is a branded safe-integer number (see D-11 "TypeScript representation").
 */
declare const satangBrand: unique symbol;
export type Satang = number & { readonly [satangBrand]: true };

export function satang(value: number): Satang {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`satang must be a safe integer, got ${value}`);
  }
  return value as Satang;
}

export const ZERO = satang(0);

function assertNonNegative(value: Satang, label: string): void {
  if (value < 0) throw new RangeError(`${label} must not be negative, got ${value}`);
}

export function sumSatang(values: readonly Satang[]): Satang {
  let total = 0;
  for (const v of values) total += v;
  return satang(total);
}

/** Parses a baht string such as "1,250.75" exactly (no floating point). */
export function bahtToSatang(input: string): Satang {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match?.[1]) throw new RangeError(`invalid baht amount: ${JSON.stringify(input)}`);
  const whole = Number(match[1].replaceAll(',', ''));
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return satang(whole * 100 + fraction);
}

/** amount × bp / 10000, rounded half up to 1 satang (the only rounding rule; 03 §1). */
export function applyBasisPoints(amount: Satang, basisPoints: number): Satang {
  assertNonNegative(amount, 'amount');
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new RangeError(`basis points must be an integer 0–10000, got ${basisPoints}`);
  }
  const scaled = satang(amount * basisPoints);
  return satang(Math.floor((scaled + 5000) / 10000));
}

export interface PricedLine {
  unitPrice: Satang;
  qty: number;
  /** Per-unit price deltas of the chosen modifier options. */
  modifierDeltas: readonly Satang[];
}

export function lineTotal(line: PricedLine): Satang {
  if (!Number.isInteger(line.qty) || line.qty < 1) {
    throw new RangeError(`qty must be a positive integer, got ${line.qty}`);
  }
  const unit = satang(line.unitPrice + sumSatang(line.modifierDeltas));
  assertNonNegative(unit, 'unit price with modifiers');
  return satang(unit * line.qty);
}

export interface OrderTotals {
  subtotal: Satang;
  discount: Satang;
  total: Satang;
}

export function orderTotals(lines: readonly PricedLine[], discount: Satang = ZERO): OrderTotals {
  if (lines.length === 0) throw new RangeError('an order needs at least one line');
  assertNonNegative(discount, 'discount');
  const subtotal = sumSatang(lines.map(lineTotal));
  if (discount > subtotal) {
    throw new RangeError(`discount ${discount} exceeds subtotal ${subtotal}`);
  }
  return { subtotal, discount, total: satang(subtotal - discount) };
}

/** Cash change: tendered ≥ amount, change = tendered − amount (03 §4). */
export function cashChange(amount: Satang, tendered: Satang): Satang {
  assertNonNegative(amount, 'amount');
  if (tendered < amount) {
    throw new RangeError(`tendered ${tendered} is less than amount ${amount}`);
  }
  return satang(tendered - amount);
}
