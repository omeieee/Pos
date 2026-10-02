import { createHash } from 'node:crypto';

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
 * A fingerprint of what a menu create asks for, to tell a genuine retry (same request id, same
 * content: return the row that was made) from a reused id (same request id, different content:
 * refuse). Mirrors `orderRequestHash`. It is taken from the parsed input, so a field left out and
 * the same field sent with its default are one request; the request id itself is the key and is
 * left out. Object keys are sorted (the channel prices are a map); array order is kept, because it
 * is display order (the groups on an item, the options in a group). `scope` is what the URL adds to
 * the body: the group an option is created in.
 */
export function menuRequestHash(
  kind: 'category' | 'item' | 'group' | 'option',
  input: { clientRequestId?: string | undefined },
  scope?: string,
): string {
  const { clientRequestId: _key, ...content } = input;
  return createHash('sha256')
    .update(canonical({ kind, scope: scope ?? null, content }))
    .digest('hex');
}
