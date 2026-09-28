import type { Tokens } from './tokens.ts';

export const CSS_VAR_PREFIX = '--sds';

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Flattens tokens to [custom property, value] pairs: color.brandHover → --sds-color-brand-hover. */
export function cssVariableEntries(tokens: Tokens): [string, string][] {
  const entries: [string, string][] = [];
  const walk = (node: object, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const next = [...path, kebab(key)];
      if (typeof value === 'object' && value !== null) walk(value, next);
      else entries.push([`${CSS_VAR_PREFIX}-${next.join('-')}`, String(value)]);
    }
  };
  walk(tokens, []);
  return entries;
}

/** Emits a CSS rule that sets every token as a custom property on `selector`. */
export function toCssVariables(tokens: Tokens, selector = ':root'): string {
  const body = cssVariableEntries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n`;
}
