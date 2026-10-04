import type { CSSProperties } from 'react';

/**
 * Turns a CSS declaration string, the way the design canvas writes inline styles, into a React
 * style object (`s('display:flex;gap:8px;--d:.05s')`). Custom properties keep their names. Used for
 * one-off layout values taken straight from the design, so they can be compared line by line.
 */
export function s(css: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!key || !value) continue;
    out[key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
      value;
  }
  return out as CSSProperties;
}
