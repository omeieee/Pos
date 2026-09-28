import {
  baseTokens,
  type DeepPartial,
  type Device,
  deviceDefaults,
  type TokenOverrides,
  type Tokens,
} from './tokens.ts';

/**
 * Customisations saved in settings (P3 adds the screen).
 * `shared` applies to every device (brand colours, fonts); each device key applies to that
 * device only, so editing `ipad` can never change `iphone` or `laptop`.
 */
export interface TokenSettings {
  shared?: TokenOverrides;
  ipad?: TokenOverrides;
  iphone?: TokenOverrides;
  laptop?: TokenOverrides;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a new object; never mutates either input. `undefined` in the patch is ignored. */
function mergeDeep<T>(target: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return target;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(current) ? mergeDeep(current, value) : deepClone(value);
  }
  return out as T;
}

function deepClone<T>(value: T): T {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = deepClone(inner);
  return out as T;
}

/**
 * Resolves the tokens for one device. Layer order (later wins):
 * 1. baseTokens → 2. settings.shared → 3. deviceDefaults[device] → 4. settings[device].
 * Pure: the inputs are never mutated and the result shares no nested objects with them.
 */
export function resolveTokens(device: Device, settings: TokenSettings = {}): Tokens {
  let tokens = deepClone(baseTokens);
  tokens = mergeDeep(tokens, settings.shared);
  tokens = mergeDeep(tokens, deviceDefaults[device]);
  tokens = mergeDeep(tokens, settings[device]);
  return tokens;
}
