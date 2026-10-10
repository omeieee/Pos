import { formatBaht, formatDate, type Locale, type MessageKey, t } from '@sds/i18n';
import type { MyOrder } from '@sds/shared';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A receipt exists once the order is paid and not cancelled (owner, 2026-10-11: offered after payment). */
export const canDownloadReceipt = (order: Pick<MyOrder, 'paymentStatus' | 'status'>) =>
  order.paymentStatus === 'paid' && order.status !== 'cancelled';

export function receiptFileName(order: Pick<MyOrder, 'orderNo'>): string {
  return `receipt-${order.orderNo.replace(/[^A-Za-z0-9-]/g, '')}.html`;
}

/** The receipt as one self-contained HTML page the customer saves or prints. No scripts, no links. */
export function receiptHtml(order: MyOrder, locale: Locale): string {
  const say = (key: MessageKey, params?: Record<string, string>) =>
    escapeHtml(t(locale, key, params));
  const method = order.payment?.method ?? 'cash';
  const methodLabel = t(locale, `payment.method.${method}` as MessageKey);
  const rows = order.items
    .map((item) => {
      const name = locale === 'en' && item.nameEn ? item.nameEn : item.nameTh;
      return `<tr><td>${escapeHtml(name)} ×${item.qty}</td><td>${escapeHtml(formatBaht(item.lineTotalSatang, locale))}</td></tr>`;
    })
    .join('');
  const when = escapeHtml(formatDate(order.completedAt ?? order.placedAt, locale, 'dateTime'));
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${say('lineBot.receipt.title')} ${escapeHtml(order.orderNo)}</title>
<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#1c1411}table{width:100%;border-collapse:collapse}td{padding:6px 0}td:last-child{text-align:right}.total td{border-top:1px solid #999;font-weight:700}small{color:#666}</style>
</head><body>
<h1>${say('liff.app.name')}</h1>
<h2>${say('lineBot.receipt.title')} · ${escapeHtml(order.orderNo)}</h2>
<p><small>${when}</small></p>
<table>${rows}<tr class="total"><td>${say('lineBot.receipt.total')}</td><td>${escapeHtml(formatBaht(order.totalSatang, locale))}</td></tr></table>
<p><small>${say('lineBot.receipt.method', { method: methodLabel })}</small></p>
<p>${say('lineBot.receipt.thanks')}</p>
</body></html>`;
}
