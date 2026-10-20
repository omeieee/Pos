import { describe, expect, test } from 'vitest';
import { CSV_BOM, itemsCsvRows, revenueCsvRows, satangDecimal, toCsv } from './csv.ts';
import type { ItemSales } from './items.ts';
import type { DayRevenue } from './revenue.ts';

describe('satangDecimal', () => {
  test.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [123456, '1234.56'],
    [-250, '-2.50'],
    [-5, '-0.05'],
  ])('%i satang -> %s', (satang, expected) => {
    expect(satangDecimal(satang)).toBe(expected);
  });

  test('refuses a non-integer, so no floating point sneaks in', () => {
    expect(() => satangDecimal(1.5)).toThrow(RangeError);
    expect(() => satangDecimal(Number.NaN)).toThrow(RangeError);
  });
});

describe('toCsv', () => {
  test('starts with a UTF-8 byte order mark so Excel reads Thai text correctly', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(toCsv([['วันที่']]).startsWith('﻿')).toBe(true);
  });

  test('joins cells with commas and rows with CRLF, ending with a line break', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c', 1],
      ]),
    ).toBe('﻿a,b\r\nc,1\r\n');
  });

  test('quotes cells that hold a comma, a quote or a line break, and doubles the quotes', () => {
    expect(toCsv([['a,b', 'say "hi"', 'x\ny']])).toBe('﻿"a,b","say ""hi""","x\ny"\r\n');
  });

  test('defuses spreadsheet formulas: a text cell starting with = + - @ gets a leading quote mark', () => {
    expect(toCsv([['=SUM(A1)', '+1', '-2+3', '@x', '\tx', 'safe']])).toBe(
      "﻿'=SUM(A1),'+1,'-2+3,'@x,'\tx,safe\r\n",
    );
  });

  test('a negative amount written as text is left alone: it cannot be a formula, and the accountant needs the minus', () => {
    expect(toCsv([[satangDecimal(-250), '-0.05', '-12']])).toBe(`${CSV_BOM}-2.50,-0.05,-12\r\n`);
    // but a minus that starts anything else is still defused
    expect(toCsv([['-1+1', '-A1', '--2']])).toBe(`${CSV_BOM}'-1+1,'-A1,'--2\r\n`);
  });

  test('numbers are written as they are, including negatives, and are never defused', () => {
    expect(toCsv([[-5, 0, 12]])).toBe('﻿-5,0,12\r\n');
  });
});

const day = (over: Partial<DayRevenue> = {}): DayRevenue => ({
  businessDate: '2026-10-01',
  revenueSatang: 27550,
  orderCount: 3,
  averageTicketSatang: 9183,
  commissionSatang: 0,
  byChannel: { storefront: 15500, line: 12050 },
  byMethod: { cash: 15500, promptpay: 12050 },
  ...over,
});

describe('revenueCsvRows', () => {
  const headers = [
    'date',
    'orders',
    'revenue',
    'avg',
    'commission',
    'cash',
    'promptpay',
    'gov',
    'platform',
    'other',
    'store',
    'line',
    'grab',
    'lineman',
    'phone',
  ];

  test('one header row, then a row per day with baht to two decimals and zeros for the empty columns', () => {
    const rows = revenueCsvRows([day()], headers);
    expect(rows[0]).toEqual(headers);
    expect(rows[1]).toEqual([
      '2026-10-01',
      3,
      '275.50',
      '91.83',
      '0.00',
      '155.00',
      '120.50',
      '0.00',
      '0.00',
      '0.00',
      '155.00',
      '120.50',
      '0.00',
      '0.00',
      '0.00',
    ]);
    expect(rows).toHaveLength(2);
  });

  test('a total row closes the sheet when there is more than one day', () => {
    const rows = revenueCsvRows(
      [
        day(),
        day({
          businessDate: '2026-10-02',
          revenueSatang: 10000,
          orderCount: 2,
          averageTicketSatang: 5000,
          commissionSatang: 3000,
          byChannel: { grab: 10000 },
          byMethod: { platform: 10000 },
        }),
      ],
      headers,
      'total',
    );
    const last = rows[rows.length - 1];
    expect(last?.[0]).toBe('total');
    expect(last?.[1]).toBe(5);
    expect(last?.[2]).toBe('375.50');
    expect(last?.[4]).toBe('30.00');
    // average ticket of the whole range: 37,550 / 5 = 7,510
    expect(last?.[3]).toBe('75.10');
    expect(last?.[8]).toBe('100.00');
  });

  test('no days gives only the header row', () => {
    expect(revenueCsvRows([], headers, 'total')).toEqual([headers]);
  });
});

describe('itemsCsvRows', () => {
  const item = (over: Partial<ItemSales>): ItemSales => ({
    menuItemId: 'a',
    name: 'ต้มยำ',
    qty: 3,
    revenueSatang: 18000,
    unitShareBp: 7500,
    popular: true,
    costedQty: 0,
    costedRevenueSatang: 0,
    costSatang: null,
    grossProfitSatang: null,
    marginBp: null,
    ...over,
  });

  test('header, then name, units and baht per item in the order given', () => {
    const rows = itemsCsvRows(
      [
        item({}),
        item({ menuItemId: 'b', name: 'ชา, เย็น', qty: 1, revenueSatang: 3000, unitShareBp: 2500 }),
      ],
      ['name', 'qty', 'revenue', 'share'],
    );
    expect(rows).toEqual([
      ['name', 'qty', 'revenue', 'share'],
      ['ต้มยำ', 3, '180.00', '75.00'],
      ['ชา, เย็น', 1, '30.00', '25.00'],
    ]);
  });
});
