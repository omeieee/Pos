import { en } from './en.ts';
import { type MessageKey, th } from './th.ts';

export const LOCALES = ['th', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'th';

export const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { th, en };

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Looks up `key` in `locale` and fills `{name}` placeholders.
 * A placeholder without a param stays visible as `{name}` rather than going silently blank.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = catalogs[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Binds a locale (Thai by default) so callers can write `tr(key)`. */
export function translator(locale: Locale = DEFAULT_LOCALE) {
  return (key: MessageKey, params?: MessageParams): string => t(locale, key, params);
}
