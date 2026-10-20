import { createHash } from 'node:crypto';
import type { CreateExpenseInput } from '@sds/shared';

/** JSON with object keys sorted at every depth, so key order never changes the fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A fingerprint of what an expense create asks for, to tell a genuine retry (same request id, same
 * content: return the row that was made) from a reused id (same id, other content: refuse). Taken
 * from the parsed input; the request id itself is the key and is left out. Kept apart from the
 * order, payment and menu fingerprints on purpose (D-29).
 */
export function expenseRequestHash(input: CreateExpenseInput): string {
  const { clientRequestId: _key, ...content } = input;
  return createHash('sha256')
    .update(canonical({ kind: 'expense', content }))
    .digest('hex');
}
