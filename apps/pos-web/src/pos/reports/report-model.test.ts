import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  averageTicket,
  bottomItems,
  CHANNEL_SLOT,
  channelShares,
  compare,
  heatGrid,
  heatLevel,
  periodRanges,
  topItems,
  weekdayShort,
} from './report-model.ts';

describe('periodRanges', () => {
  test('today is compared with yesterday', () => {
    expect(periodRanges('today', '2026-10-17')).toEqual({
      current: { from: '2026-10-17', to: '2026-10-17' },
      previous: { from: '2026-10-16', to: '2026-10-16' },
    });
  });

  test('yesterday crosses a month and a year end', () => {
    expect(periodRanges('today', '2026-10-01').previous.from).toBe('2026-09-30');
    expect(periodRanges('today', '2027-01-01').previous.from).toBe('2026-12-31');
  });

  test('week runs Monday to today, against the same span of the week before', () => {
    // 2026-10-17 is a Saturday: this week is Mon 12 .. Sat 17, last week Mon 5 .. Sat 10
    expect(periodRanges('week', '2026-10-17')).toEqual({
      current: { from: '2026-10-12', to: '2026-10-17' },
      previous: { from: '2026-10-05', to: '2026-10-10' },
    });
  });

  test('on a Monday the week is one day long', () => {
    expect(periodRanges('week', '2026-10-12')).toEqual({
      current: { from: '2026-10-12', to: '2026-10-12' },
      previous: { from: '2026-10-05', to: '2026-10-05' },
    });
  });

  test('on a Sunday the week is seven days long (Monday is the first day)', () => {
    expect(periodRanges('week', '2026-10-18').current).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
  });

  test('month runs from the 1st to today, against the same days of the month before', () => {
    expect(periodRanges('month', '2026-10-17')).toEqual({
      current: { from: '2026-10-01', to: '2026-10-17' },
      previous: { from: '2026-09-01', to: '2026-09-17' },
    });
  });

  test('the previous month is cut to its own length (31 March -> 28 February)', () => {
    expect(periodRanges('month', '2027-03-31').previous).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
    expect(periodRanges('month', '2028-03-31').previous).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(periodRanges('month', '2027-01-15').previous).toEqual({
      from: '2026-12-01',
      to: '2026-12-15',
    });
  });

  test('year runs from 1 January to today, against the same days of the year before', () => {
    expect(periodRanges('year', '2026-10-17')).toEqual({
      current: { from: '2026-01-01', to: '2026-10-17' },
      previous: { from: '2025-01-01', to: '2025-10-17' },
    });
  });

  test('29 February compares with 28 February of the year before', () => {
    expect(periodRanges('year', '2028-02-29').previous).toEqual({
      from: '2027-01-01',
      to: '2027-02-28',
    });
  });

  test('the longest range stays within what the API accepts (366 days)', () => {
    const { current, previous } = periodRanges('year', '2028-12-31');
    for (const r of [current, previous]) {
      const days =
        (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(366);
    }
  });
});

describe('compare', () => {
  test('up: whole difference and a percentage in tenths, rounded half up', () => {
    // 4,860 vs 4,660 baht: +200 baht, +4.29% -> 4.3
    expect(compare(486000, 466000)).toEqual({ direction: 'up', diff: 20000, tenthsPercent: 43 });
  });

  test('down: negative difference, the direction says down and the percentage is positive', () => {
    expect(compare(12800, 13300)).toEqual({ direction: 'down', diff: -500, tenthsPercent: 38 });
  });

  test('equal is flat', () => {
    expect(compare(500, 500)).toEqual({ direction: 'flat', diff: 0, tenthsPercent: 0 });
  });

  test('no earlier figure: there is no percentage to give', () => {
    expect(compare(500, 0)).toEqual({ direction: 'up', diff: 500, tenthsPercent: null });
    expect(compare(0, 0)).toEqual({ direction: 'flat', diff: 0, tenthsPercent: null });
  });

  test('refuses a fractional figure', () => {
    expect(() => compare(1.5, 1)).toThrow(RangeError);
  });
});

describe('channelShares', () => {
  const day = (byChannel: Record<string, number>) => ({ byChannel });

  test('adds the days, drops empty channels, keeps the fixed channel order, and gives each its colour slot', () => {
    const rows = channelShares([
      day({ line: 6000, storefront: 2000 }),
      day({ grab: 2000, line: 0 }),
    ]);
    expect(rows).toEqual([
      { channel: 'storefront', slot: CHANNEL_SLOT.storefront, amountSatang: 2000, percent: 20 },
      { channel: 'line', slot: CHANNEL_SLOT.line, amountSatang: 6000, percent: 60 },
      { channel: 'grab', slot: CHANNEL_SLOT.grab, amountSatang: 2000, percent: 20 },
    ]);
  });

  test('a channel keeps its slot whatever else is shown (colour follows the entity)', () => {
    expect(channelShares([day({ grab: 100 })])[0]?.slot).toBe(CHANNEL_SLOT.grab);
    expect(CHANNEL_SLOT).toEqual({ storefront: 1, line: 2, grab: 3, lineman: 4, phone: 5 });
  });

  test('percentages add up to 100 (largest remainder), however the shares round', () => {
    const rows = channelShares([day({ storefront: 1, line: 1, grab: 1 })]);
    expect(rows.map((r) => r.percent).reduce((a, b) => a + b, 0)).toBe(100);
    expect(rows.map((r) => r.percent).sort()).toEqual([33, 33, 34]);
  });

  test('nothing sold gives no rows', () => {
    expect(channelShares([])).toEqual([]);
    expect(channelShares([day({})])).toEqual([]);
  });
});

describe('topItems and bottomItems', () => {
  const item = (name: string, qty: number) => ({
    menuItemId: name,
    name,
    qty,
    revenueSatang: satang(qty * 100),
    unitShareBp: 0,
    popular: false,
    costedQty: 0,
    costedRevenueSatang: satang(0),
    costSatang: null,
    grossProfitSatang: null,
    marginBp: null,
  });
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => item(n, 10 - i));

  test('top: the first n of the best-first list', () => {
    expect(topItems(list, 3).map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });

  test('bottom: the last n, worst first', () => {
    expect(bottomItems(list, 3).map((i) => i.name)).toEqual(['g', 'f', 'e']);
  });

  test('a short list is not split twice: bottom leaves out what top already shows', () => {
    const short = list.slice(0, 5);
    expect(topItems(short, 5).map((i) => i.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(bottomItems(short, 5, 5)).toEqual([]);
    expect(bottomItems(list, 5, 5).map((i) => i.name)).toEqual(['g', 'f']);
  });

  test('empty in, empty out', () => {
    expect(topItems([], 5)).toEqual([]);
    expect(bottomItems([], 5)).toEqual([]);
  });
});

describe('heatGrid and heatLevel', () => {
  const cell = (weekday: number, hour: number, orderCount: number) => ({
    weekday,
    hour,
    orderCount,
    revenueSatang: satang(orderCount * 100),
  });

  test('puts counts in a weekday x hour grid over the busy hours, Monday first', () => {
    const grid = heatGrid([cell(1, 9, 4), cell(4, 13, 9), cell(7, 14, 1)]);
    expect(grid.hours).toEqual([9, 10, 11, 12, 13, 14]);
    expect(grid.max).toBe(9);
    expect(grid.rows).toHaveLength(7);
    expect(grid.rows[0]).toEqual({ weekday: 1, counts: [4, 0, 0, 0, 0, 0] });
    expect(grid.rows[3]).toEqual({ weekday: 4, counts: [0, 0, 0, 0, 9, 0] });
    expect(grid.rows[6]).toEqual({ weekday: 7, counts: [0, 0, 0, 0, 0, 1] });
  });

  test('shows at least six hours, so a quiet shop does not give a sliver', () => {
    const grid = heatGrid([cell(2, 12, 3)]);
    expect(grid.hours.length).toBeGreaterThanOrEqual(6);
    expect(grid.hours).toContain(12);
    expect(grid.hours[0]).toBeGreaterThanOrEqual(0);
    expect(grid.hours[grid.hours.length - 1]).toBeLessThanOrEqual(23);
  });

  test('no cells gives an empty grid', () => {
    expect(heatGrid([])).toEqual({ hours: [], rows: [], max: 0 });
  });

  test('levels: 0 is empty, the busiest cell is the top level, steps are even', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(8, 10)).toBe(4 - 0);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe('averageTicket', () => {
  test('revenue over orders, rounded half up to one satang, and 0 with no orders', () => {
    expect(averageTicket(27550, 3)).toBe(9183);
    expect(averageTicket(20100, 2)).toBe(10050);
    expect(averageTicket(201, 2)).toBe(101);
    expect(averageTicket(0, 0)).toBe(0);
  });
});

describe('weekdayShort', () => {
  test('ISO weekday 1 is Monday and 7 is Sunday, in Thai and English', () => {
    expect(weekdayShort(1, 'th')).toMatch(/^จ/);
    expect(weekdayShort(7, 'th')).toMatch(/^อา/);
    expect(new Set([1, 2, 3, 4, 5, 6, 7].map((d) => weekdayShort(d, 'th'))).size).toBe(7);
    expect(weekdayShort(1, 'en')).toBe('Mon');
    expect(weekdayShort(7, 'en')).toBe('Sun');
  });
});
