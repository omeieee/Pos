/**
 * The owner's correction of a past order, as pure functions (no React, no I/O): the edit draft, the
 * request it becomes, and who may see the actions. No money is computed here: a saved line keeps its
 * sold price and the server recomputes every total, so the screen shows only what the server sent.
 */
import {
  type CorrectOrderInput,
  hasPermission,
  type OrderDto,
  type PastOrderPaymentAction,
  type StaffRole,
} from '@sds/shared';
import type { MenuItemView } from './menu-model.ts';

export const MAX_LINE_QTY = 99;

export interface DraftLine {
  /** Stable key for the list. */
  key: string;
  /** A saved line (keeps its sold price), or null for a line added now. */
  orderItemId: string | null;
  /** Set on a line added now (priced from today's menu). */
  menuItemId: string | null;
  nameTh: string;
  nameEn: string | null;
  qty: number;
  note: string | null;
}

/** A payment the owner must decide about: the customer claimed it, or it was received. */
const ACTIVE_PAYMENT: readonly OrderDto['paymentStatus'][] = [
  'awaiting_confirmation',
  'paid',
  'partially_paid',
];

export const hasActivePayment = (order: OrderDto): boolean =>
  order.status !== 'cancelled' && ACTIVE_PAYMENT.includes(order.paymentStatus);

/** The actions are the owner's: the shared permission decides, and a voided order has nothing to change. */
export const canCorrectOrder = (
  role: StaffRole | null | undefined,
  order: Pick<OrderDto, 'status'>,
): boolean =>
  role !== null &&
  role !== undefined &&
  hasPermission(role, 'order.edit_past') &&
  order.status !== 'cancelled';

export const draftFromOrder = (order: OrderDto): DraftLine[] =>
  order.items.map((item) => ({
    key: item.id,
    orderItemId: item.id,
    menuItemId: null,
    nameTh: item.nameTh,
    nameEn: item.nameEn,
    qty: item.qty,
    note: item.note,
  }));

export const setLineQty = (lines: readonly DraftLine[], key: string, qty: number): DraftLine[] =>
  lines.map((line) =>
    line.key === key
      ? { ...line, qty: Math.min(MAX_LINE_QTY, Math.max(1, Math.trunc(qty))) }
      : line,
  );

/** An order keeps at least one line: dropping everything is a void. */
export const removeLine = (lines: readonly DraftLine[], key: string): DraftLine[] =>
  lines.length <= 1 ? [...lines] : lines.filter((line) => line.key !== key);

/** Dishes that can be added with no options to pick (the options picker is not part of this sheet). */
export const addableItems = (items: readonly MenuItemView[]): MenuItemView[] =>
  items.filter((item) => item.orderable && item.groups.every((group) => !group.required));

export function addMenuLine(lines: readonly DraftLine[], item: MenuItemView): DraftLine[] {
  const key = `new:${item.id}`;
  if (lines.some((line) => line.key === key)) {
    return lines.map((line) =>
      line.key === key ? { ...line, qty: Math.min(MAX_LINE_QTY, line.qty + 1) } : line,
    );
  }
  return [
    ...lines,
    {
      key,
      orderItemId: null,
      menuItemId: item.id,
      nameTh: item.nameTh,
      nameEn: item.nameEn,
      qty: 1,
      note: null,
    },
  ];
}

function linesChanged(order: OrderDto, lines: readonly DraftLine[]): boolean {
  if (lines.length !== order.items.length) return true;
  return lines.some((line) => {
    const saved = order.items.find((item) => item.id === line.orderItemId);
    return !saved || saved.qty !== line.qty;
  });
}

export interface CorrectionDraft {
  lines: readonly DraftLine[];
  note: string;
  reason: string;
  paymentAction: PastOrderPaymentAction | null;
}

/** Whether something differs from the saved order (otherwise the server answers NOTHING_TO_CHANGE). */
export function hasChange(
  order: OrderDto,
  draft: Pick<CorrectionDraft, 'lines' | 'note'>,
): boolean {
  return linesChanged(order, draft.lines) || draft.note.trim() !== (order.note ?? '');
}

/** The PATCH body, or null while the reason is empty or nothing was changed. Only what changed is sent. */
export function buildCorrection(order: OrderDto, draft: CorrectionDraft): CorrectOrderInput | null {
  const reason = draft.reason.trim();
  if (reason === '' || !hasChange(order, draft)) return null;
  const note = draft.note.trim();
  const noteChanged = note !== (order.note ?? '');
  return {
    expectedVersion: order.version,
    reason,
    ...(noteChanged ? { note: note === '' ? null : note } : {}),
    ...(linesChanged(order, draft.lines)
      ? {
          items: draft.lines.map((line) =>
            line.orderItemId
              ? { orderItemId: line.orderItemId, qty: line.qty, note: line.note }
              : {
                  menuItemId: line.menuItemId ?? '',
                  qty: line.qty,
                  modifierOptionIds: [],
                  ...(line.note ? { note: line.note } : {}),
                },
          ),
        }
      : {}),
    ...(draft.paymentAction && hasActivePayment(order)
      ? { paymentAction: draft.paymentAction }
      : {}),
  };
}
