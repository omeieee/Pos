/**
 * Which design-token set (A4: iPad, iPhone or laptop) the screen uses. A registered device
 * uses the kind the owner gave it, because per-device customisation is keyed by that kind;
 * until then the screen decides from its size and pointer.
 */
import type { DeviceKind } from '@sds/shared';
import { type Device, resolveTokens, toCssVariables } from '@sds/ui';

export interface ViewportInfo {
  width: number;
  /** A finger, not a mouse: `(pointer: coarse)`. */
  coarsePointer: boolean;
}

/** Below this width the phone layout is used (iPhone portrait is 390). */
export const PHONE_MAX_WIDTH = 599;
/** A mouse at or above this width is a laptop (an iPad landscape is 1180). */
export const LAPTOP_MIN_WIDTH = 1280;

export function pickDevice(kind: DeviceKind | null, viewport: ViewportInfo): Device {
  if (kind === 'ipad' || kind === 'iphone' || kind === 'laptop') return kind;
  if (viewport.width <= PHONE_MAX_WIDTH) return 'iphone';
  if (viewport.coarsePointer || viewport.width < LAPTOP_MIN_WIDTH) return 'ipad';
  return 'laptop';
}

/** The kind to suggest when registering a device, from what it looks like now. */
export function suggestedKind(viewport: ViewportInfo): Device {
  return pickDevice(null, viewport);
}

/** CSS custom properties (`--sds-*`) for the device, set on `:root`. */
export function tokensCss(device: Device): string {
  return toCssVariables(resolveTokens(device), ':root');
}
