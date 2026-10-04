import { useViewport } from '../ui/hooks.ts';

/**
 * Which chrome the staff app wears (design canvas): `phone` has the floating tab bar, `rail` is the
 * iPad's glass navigation rail, `side` is the laptop's sidebar. Chosen from the width of the window.
 */
export type Layout = 'phone' | 'rail' | 'side';

/** Same breakpoint as before the redesign: at or below it the cart is a sheet behind a bar. */
export const PHONE_MAX_WIDTH = 719;
/** An iPad landscape is 1180; the laptop design starts where a mouse-sized window starts. */
export const SIDE_MIN_WIDTH = 1280;

export function layoutFor(width: number): Layout {
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (width >= SIDE_MIN_WIDTH) return 'side';
  return 'rail';
}

export function useLayout(): Layout {
  return layoutFor(useViewport().width);
}
