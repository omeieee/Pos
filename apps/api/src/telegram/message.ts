/**
 * What a Telegram payment alert says (D-42). Pure: no I/O.
 *
 * Plain text only, sent without a parse mode, so a customer's name can never be read as markup.
 * The input type is the allow-list: the LINE name, the name given in the order, the delivery
 * building, the dishes and the total. There is no field for a phone number, a room, a note or a
 * slip, so none can be printed (CLAUDE.md rule 10 as amended by D-42).
 */
import { formatBaht } from '@sds/i18n';
import type { PaymentAlertKind } from '@sds/shared';

export interface TelegramAlert {
  kind: PaymentAlertKind;
  orderNo: string;
  totalSatang: number;
  lineName: string | null;
  recipientName: string | null;
  building: string | null;
  lines: { name: string; qty: number }[];
}

/** Telegram's limit for a photo caption. */
export const CAPTION_LIMIT = 1024;

const HEADERS: Record<PaymentAlertKind, string> = {
  paid: '✅ ชำระแล้ว',
  slip_review: '🟡 ตรวจสลิป',
};

/** `62฿` or `62.50฿`: whole baht without decimals. */
function baht(satang: number): string {
  return `${formatBaht(satang, 'th', { decimals: 'auto' }).replace('฿', '')}฿`;
}

/** One line of customer-given text: control characters and line breaks become spaces. */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

function field(label: string, value: string | null): string[] {
  const clean = value === null ? '' : oneLine(value);
  return clean === '' ? [] : [`${label}: ${clean}`];
}

/** The header line only (what a photo caption carries when the full text is too long). */
export function alertHeader(
  alert: Pick<TelegramAlert, 'kind' | 'orderNo' | 'totalSatang'>,
): string {
  return `${HEADERS[alert.kind]} #${oneLine(alert.orderNo)} · ${baht(alert.totalSatang)}`;
}

export function alertText(alert: TelegramAlert): string {
  return [
    alertHeader(alert),
    ...field('LINE', alert.lineName),
    ...field('ชื่อ', alert.recipientName),
    ...field('ตึก', alert.building),
    ...alert.lines.map((line) => `${oneLine(line.name)} × ${line.qty}`),
    `รวม ${baht(alert.totalSatang)}`,
  ].join('\n');
}

/** `base` + a server path such as `/v1/menu/items/:id/photo?v=2`; null unless the base is https and the path is relative. */
export function absolutePhotoUrl(base: string, path: string): string | null {
  if (!base.startsWith('https://') || !path.startsWith('/') || path.startsWith('//')) return null;
  return `${base.replace(/\/+$/, '')}${path}`;
}

const LINE_HOSTS = ['line-scdn.net', 'line.me', 'line-apps.com'];

/** A profile picture Telegram may be asked to fetch: https on a LINE host, nothing else. */
export function isLinePictureUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      LINE_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}
