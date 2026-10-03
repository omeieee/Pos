/**
 * Checkout rules the screen needs before it can enable the button. They only save a round trip:
 * the server checks the building list, the hours and the method again and its answer wins.
 */
import type { AppPayMethod, CheckoutInfo } from '@sds/shared';

export const NAME_MAX = 60;
export const NOTE_MAX = 200;

export interface CheckoutForm {
  building: string;
  name: string;
  note: string;
  method: AppPayMethod | '';
}

export type FormProblem = 'building' | 'name' | 'method' | 'closed';

export function formProblems(form: CheckoutForm, info: CheckoutInfo): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!info.buildings.includes(form.building)) problems.push('building');
  if (form.name.trim() === '' || form.name.trim().length > NAME_MAX) problems.push('name');
  if (form.method === '' || !info.methods.includes(form.method)) problems.push('method');
  if (!info.delivery.open) problems.push('closed');
  return problems;
}

/** The form with the last recipient filled in, when that building is still on the list. */
export function prefilled(info: CheckoutInfo): CheckoutForm {
  const last = info.lastRecipient;
  const usable = last !== null && info.buildings.includes(last.building);
  return {
    building: usable ? last.building : '',
    name: usable ? last.recipientName : '',
    note: usable ? (last.deliveryNote ?? '') : '',
    method: info.methods.includes('promptpay') ? 'promptpay' : (info.methods[0] ?? ''),
  };
}

/**
 * One request id per cart content: pressing the button again, or retrying after a lost answer,
 * sends the same id so the server returns the same order instead of a second one. A changed
 * cart or form gets a new id.
 */
export function createRequestIds(newId: () => string = () => crypto.randomUUID()) {
  let signature = '';
  let id = '';
  return {
    forSignature(next: string): string {
      if (next !== signature || id === '') {
        signature = next;
        id = newId();
      }
      return id;
    },
    /** After a successful order: the next order is a new one. */
    reset(): void {
      signature = '';
      id = '';
    },
  };
}

/** `HH:MM` from minutes since midnight. */
export const clock = (minute: number): string =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
