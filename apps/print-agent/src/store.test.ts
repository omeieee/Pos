import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openPrintedStore } from './store.ts';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'sds-print-')), 'printed.json');

describe('printed store', () => {
  it('remembers printed ids across a restart and keeps the ack owed until confirmed', () => {
    const file = tempFile();
    const id = randomUUID();
    const lease = randomUUID();
    const first = openPrintedStore(file);
    expect(first.has(id)).toBe(false);
    first.recordPrinted(id, lease);

    const second = openPrintedStore(file);
    expect(second.has(id)).toBe(true);
    expect(second.owed().map((entry) => [entry.id, entry.leaseToken])).toEqual([[id, lease]]);
    second.markAcked(id);
    expect(openPrintedStore(file).owed()).toEqual([]);
    expect(openPrintedStore(file).has(id)).toBe(true);
  });

  it('stores only ids, lease tokens and times', () => {
    const file = tempFile();
    openPrintedStore(file).recordPrinted(randomUUID(), randomUUID());
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(Object.keys(saved.jobs[0] ?? {}).sort()).toEqual([
      'acked',
      'id',
      'leaseToken',
      'printedAt',
    ]);
  });

  it('starts empty, and says so, when the file is damaged', () => {
    const file = tempFile();
    writeFileSync(file, '{not json');
    const problems: string[] = [];
    const store = openPrintedStore(file, { onProblem: (event) => problems.push(event) });
    expect(store.owed()).toEqual([]);
    expect(problems).toEqual(['unreadable']);
    store.recordPrinted(randomUUID(), randomUUID()); // and it can write a fresh file
    expect(openPrintedStore(file).owed()).toHaveLength(1);
  });

  it('forgets acked entries after two weeks but never an owed one', () => {
    const file = tempFile();
    const old = randomUUID();
    const owed = randomUUID();
    let now = new Date('2026-10-01T00:00:00Z');
    const store = openPrintedStore(file, { now: () => now });
    store.recordPrinted(old, randomUUID());
    store.markAcked(old);
    store.recordPrinted(owed, randomUUID());
    now = new Date('2026-10-22T00:00:00Z');
    store.recordPrinted(randomUUID(), randomUUID()); // any save prunes
    expect(store.has(old)).toBe(false);
    expect(store.has(owed)).toBe(true);
  });

  it('keeps working when the file cannot be written', () => {
    const problems: string[] = [];
    const store = openPrintedStore(join(tmpdir(), 'no-such-dir-sds', 'x.json'), {
      onProblem: (event) => problems.push(event),
    });
    const id = randomUUID();
    store.recordPrinted(id, randomUUID());
    expect(store.has(id)).toBe(true);
    expect(problems).toEqual(['unwritable']);
  });
});
