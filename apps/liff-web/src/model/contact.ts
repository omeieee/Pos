/**
 * "Call the shop". The number is the shop phone from the owner's settings; the customer app gets
 * it from the API (`shopPhone` on the checkout info); nothing is shown when there is none.
 */
import type { CheckoutInfo } from '@sds/shared';

/** The `tel:` link for a phone number typed by the owner ("081-234 5678", "+66 81 234 5678"). */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  // A "+" only means something at the start; anything else typed in the middle is noise.
  const clean = `${digits.startsWith('+') ? '+' : ''}${digits.replace(/\+/g, '')}`;
  return clean.replace('+', '').length >= 5 ? `tel:${clean}` : null;
}

/** The shop phone from the checkout info (`shopPhone`, null when the owner saved none). */
export function shopPhoneOf(info: Pick<CheckoutInfo, 'shopPhone'> | null): string | null {
  const phone = info?.shopPhone;
  return typeof phone === 'string' && phone.trim() ? phone.trim() : null;
}
