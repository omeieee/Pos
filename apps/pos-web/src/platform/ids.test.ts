import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { newUuid } from './ids.ts';

describe('newUuid', () => {
  test('uses crypto.randomUUID when the context has it', () => {
    const fixed = '3f1c2a7e-8b4d-4e6a-9c1f-2d5b7a9e0c11';
    const source = {
      randomUUID: () => fixed,
      getRandomValues: crypto.getRandomValues.bind(crypto),
    };
    expect(newUuid(source)).toBe(fixed);
  });

  test('falls back to getRandomValues where randomUUID does not exist (insecure LAN context)', () => {
    const source = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const ids = new Set(Array.from({ length: 50 }, () => newUuid(source)));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // The API validates clientRequestId with z.uuid().
      expect(z.uuid().safeParse(id).success).toBe(true);
    }
  });
});
