import type { Locale } from '@sds/i18n';

/** The name in the shown language: English when asked for and given, else Thai. */
export function localName(locale: Locale, nameTh: string, nameEn: string | null): string {
  return locale === 'en' && nameEn ? nameEn : nameTh;
}
