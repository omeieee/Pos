import type { z } from 'zod';
import { validationError } from './errors.ts';

/** Zod at the boundary: returns the parsed value or throws a 400 that never echoes input. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
