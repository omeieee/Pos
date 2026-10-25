import { describe, expect, test } from 'vitest';
import { uuidv7 } from './uuid7.ts';

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampOf = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
// Postgres compares uuids byte by byte, which is the same as comparing the lowercase text.
const ascending = (ids: string[]) => ids.every((id, i) => i === 0 || (ids[i - 1] ?? '') < id);

describe('uuidv7', () => {
  test('is a version 7, RFC variant uuid carrying the millisecond timestamp', () => {
    const ms = Date.UTC(2026, 9, 25, 3, 0, 0, 123);
    const id = uuidv7(ms);
    expect(id).toMatch(FORMAT);
    expect(timestampOf(id)).toBe(ms);
  });

  test('ids made in the same millisecond come out in increasing order', () => {
    const ms = Date.UTC(2027, 0, 1);
    const ids = Array.from({ length: 1000 }, () => uuidv7(ms));
    expect(ascending(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => timestampOf(id) === ms)).toBe(true);
  });

  test('more than 4,096 ids in one millisecond borrow the next millisecond and stay in order', () => {
    const ms = Date.UTC(2027, 0, 2);
    const ids = Array.from({ length: 10_000 }, () => uuidv7(ms));
    expect(ascending(ids)).toBe(true);
    expect(ids.every((id) => id.match(FORMAT))).toBe(true);
    expect(timestampOf(ids.at(-1) ?? '')).toBeGreaterThan(ms);
  });

  test('a clock that steps back does not break the order', () => {
    const ms = Date.UTC(2027, 0, 3);
    const ids = [uuidv7(ms), uuidv7(ms - 5_000), uuidv7(ms - 1), uuidv7(ms + 1)];
    expect(ascending(ids)).toBe(true);
  });

  test('a later millisecond sorts after an earlier one', () => {
    const ms = Date.UTC(2027, 0, 4);
    expect(uuidv7(ms) < uuidv7(ms + 1)).toBe(true);
  });
});
