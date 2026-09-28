import { expect, test } from 'vitest';
import { PLACEHOLDER } from './index.ts';

test('toolchain', () => {
  expect(PLACEHOLDER).toBe(1);
});
