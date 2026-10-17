/**
 * CSV for the accountant (P6, B5). Pure. Money is written in baht with two decimals from integer
 * satang (no floating point). The file starts with a UTF-8 byte order mark so Excel reads Thai text
 * correctly, rows end with CRLF, and a text cell that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return gets a leading quote mark so a spreadsheet cannot run it as a formula.
 * Dates are ISO (Gregorian) on purpose: they sort and import the same everywhere.
 */
import { ORDER_CHANNELS, PAYMENT_METHODS } from '@sds/shared';
import type { ItemSales } from './items.ts';
import type { DayRevenue } from './revenue.ts';

export const CSV_BOM = '﻿';

export type CsvCell = string | number;

/** Integer satang as a decimal string in baht: 123456 -> "1234.56", -5 -> "-0.05". */
export function satangDecimal(satang: number): string {
  if (!Number.isSafeInteger(satang)) {
    throw new RangeError(`satang must be a safe integer, got ${satang}`);
  }
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${satang < 0 ? '-' : ''}${baht}.${fraction}`;
}

function cell(value: CsvCell): string {
  if (typeof value === 'number') return String(value);
  // A plain negative number (a refund, a loss) is not a formula and must keep its minus.
  const plainNumber = /^-\d+(\.\d+)?$/.test(value);
  const safe = !plainNumber && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return `${CSV_BOM}${rows.map((row) => `${row.map(cell).join(',')}\r\n`).join('')}`;
}

/** Columns after the first five: one per payment method, then one per channel. */
const COLUMNS = PAYMENT_METHODS.length + ORDER_CHANNELS.length + 5;

function dayRow(label: string, d: DayRevenue): CsvCell[] {
  return [
    label,
    d.orderCount,
    satangDecimal(d.revenueSatang),
    satangDecimal(d.averageTicketSatang),
    satangDecimal(d.commissionSatang),
    ...PAYMENT_METHODS.map((m) => satangDecimal(d.byMethod[m] ?? 0)),
    ...ORDER_CHANNELS.map((c) => satangDecimal(d.byChannel[c] ?? 0)),
  ];
}

/**
 * Header row, a row per business date, and (with `totalLabel`, and more than one day) a total row.
 * `headers` must name every column: date, orders, revenue, average ticket, commission, then one per
 * payment method (cash, promptpay, gov_copay, platform, other) and one per channel (storefront,
 * line, grab, lineman, phone).
 */
export function revenueCsvRows(
  days: readonly DayRevenue[],
  headers: readonly string[],
  totalLabel?: string,
): CsvCell[][] {
  if (headers.length !== COLUMNS) {
    throw new RangeError(`expected ${COLUMNS} headers, got ${headers.length}`);
  }
  const rows: CsvCell[][] = [[...headers], ...days.map((d) => dayRow(d.businessDate, d))];
  if (totalLabel !== undefined && days.length > 1) {
    const total: DayRevenue = {
      businessDate: totalLabel,
      revenueSatang: 0,
      orderCount: 0,
      averageTicketSatang: 0,
      commissionSatang: 0,
      byChannel: {},
      byMethod: {},
    };
    for (const d of days) {
      total.revenueSatang += d.revenueSatang;
      total.orderCount += d.orderCount;
      total.commissionSatang += d.commissionSatang;
      for (const m of PAYMENT_METHODS)
        total.byMethod[m] = (total.byMethod[m] ?? 0) + (d.byMethod[m] ?? 0);
      for (const c of ORDER_CHANNELS)
        total.byChannel[c] = (total.byChannel[c] ?? 0) + (d.byChannel[c] ?? 0);
    }
    total.averageTicketSatang = Math.floor(
      (2 * total.revenueSatang + total.orderCount) / (2 * total.orderCount),
    );
    rows.push(dayRow(totalLabel, total));
  }
  return rows;
}

/** Header (name, units, revenue, share of units) and a row per item, in the order given. */
export function itemsCsvRows(items: readonly ItemSales[], headers: readonly string[]): CsvCell[][] {
  if (headers.length !== 4) throw new RangeError(`expected 4 headers, got ${headers.length}`);
  return [
    [...headers],
    // unitShareBp / 100 is a percent with two decimals, so the same integer formatter serves
    ...items.map((i) => [
      i.name,
      i.qty,
      satangDecimal(i.revenueSatang),
      satangDecimal(i.unitShareBp),
    ]),
  ];
}
