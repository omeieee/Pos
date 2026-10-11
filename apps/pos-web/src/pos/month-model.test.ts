import { describe, expect, test } from 'vitest';
import {
  calendarCells,
  dayToOpen,
  monthLabel,
  monthOf,
  shiftMonth,
  weekdayHeadings,
} from './month-model.ts';

describe('shiftMonth', () => {
  test('moves across year ends in both directions', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-03', -15)).toBe('2024-12');
    expect(shiftMonth('2026-10', 0)).toBe('2026-10');
  });
  test('monthOf takes the month of a date', () => expect(monthOf('2026-10-11')).toBe('2026-10'));
});

describe('calendarCells', () => {
  test('October 2026 starts on a Thursday, so four blanks come first, and weeks are full', () => {
    const cells = calendarCells('2026-10');
    expect(cells.slice(0, 5)).toEqual([null, null, null, null, '2026-10-01']);
    expect(cells.filter(Boolean)).toHaveLength(31);
    expect(cells.length % 7).toBe(0);
  });
  test('a leap February has 29 days; a month starting on Sunday has no leading blank', () => {
    expect(calendarCells('2028-02').filter(Boolean)).toHaveLength(29);
    expect(calendarCells('2026-02')[0]).toBe('2026-02-01'); // 1 Feb 2026 is a Sunday
    expect(calendarCells('2026-02')).toHaveLength(28);
  });
});

describe('labels', () => {
  test('Thai uses the Buddhist Era, English the Gregorian year', () => {
    expect(monthLabel('2026-10', 'th')).toContain('2569');
    expect(monthLabel('2026-10', 'en')).toBe('October 2026');
  });
  test('seven headings, Sunday first', () => {
    expect(weekdayHeadings('en')[0]).toBe('Sun');
    expect(weekdayHeadings('th')).toHaveLength(7);
    expect(weekdayHeadings('th')[0]).toMatch(/อา/);
  });
});

describe('dayToOpen', () => {
  test('today (and later) opens the live day, an earlier date opens that day', () => {
    expect(dayToOpen('2026-10-11', '2026-10-11')).toBeNull();
    expect(dayToOpen('2026-10-12', '2026-10-11')).toBeNull();
    expect(dayToOpen('2026-10-10', '2026-10-11')).toBe('2026-10-10');
  });
});
