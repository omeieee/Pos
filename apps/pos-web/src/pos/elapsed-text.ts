import type { Tr } from '../ui/hooks.ts';
import { elapsedParts } from './order-board.ts';

/** "12 min", or "1 h 5 min" from an hour on; the words come from the catalog. */
export function elapsedText(tr: Tr, minutes: number): string {
  const { hours, minutes: rest } = elapsedParts(minutes);
  return hours > 0
    ? tr('orders.elapsedHours', { hours, minutes: rest })
    : tr('duration.minutes', { count: rest });
}
