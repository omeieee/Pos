import { describe, expect, test } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import * as entry from './index.ts';

describe('package entry points', () => {
  test('the production entry (@sds/db) does not export seed, which holds the test PromptPay ID', () => {
    expect(Object.keys(entry)).not.toContain('seed');
  });

  test('seed is its own entry, @sds/db/seed', () => {
    expect(pkg.exports['./seed']).toBe('./src/seed.ts');
  });
});
