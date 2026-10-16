/**
 * Orders keyed in by hand from a delivery platform (Grab, LINE MAN), as pure functions. The
 * platform's own order code has no field on the order yet (the shared order has no
 * `platformOrderRef` and nowhere to keep a commission), so until the backend adds one the code
 * travels in the order's note, where whoever hands the bag to the rider can read it. Nothing else
 * about the order is special: the server prices it from the platform's channel prices.
 */
import type { OrderChannel, OrderDto } from '@sds/shared';
import { z } from 'zod';

export const PLATFORM_CHANNELS = ['grab', 'lineman'] as const;
export type PlatformChannel = (typeof PLATFORM_CHANNELS)[number];

export const isPlatformChannel = (channel: OrderChannel): channel is PlatformChannel =>
  channel === 'grab' || channel === 'lineman';

/** What the note starts with (brand names, not translated). */
const TAG: Record<PlatformChannel, string> = { grab: 'GRAB', lineman: 'LINE MAN' };

export const PLATFORM_REF_MAX = 40;
/**
 * The kitchen note's limit for a platform order: the order's note holds 500 characters, and the
 * tag (at most 8), the reference (at most 40) and the separator (3) come first.
 */
export const PLATFORM_NOTE_MAX = 400;

export const platformRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLATFORM_REF_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this rejects them on purpose
  .regex(/^[^\u0000-\u001f\u007f]+$/);

const head = (channel: PlatformChannel, ref: string) => `${TAG[channel]} ${ref.trim()}`;

/** "GRAB GF-12 · no chili": the platform and its code first, then the kitchen note. */
export function platformNote(channel: PlatformChannel, ref: string, kitchenNote: string): string {
  const extra = kitchenNote.trim();
  return extra === '' ? head(channel, ref) : `${head(channel, ref)} · ${extra}`;
}

const startsWithRef = (note: string | null, channel: PlatformChannel, ref: string) => {
  if (note === null) return false;
  const wanted = head(channel, ref).toLowerCase();
  const have = note.toLowerCase();
  return have === wanted || have.startsWith(`${wanted} · `);
};

/** Whether this platform order code was already keyed in (an order, or one waiting to sync). */
export function duplicatePlatformRef(
  orders: Iterable<Pick<OrderDto, 'channel' | 'note'>>,
  queued: Iterable<{ channel: OrderChannel; note: string | null }>,
  channel: PlatformChannel,
  ref: string,
): boolean {
  if (ref.trim() === '') return false;
  for (const order of orders) {
    if (order.channel === channel && startsWithRef(order.note, channel, ref)) return true;
  }
  for (const entry of queued) {
    if (entry.channel === channel && startsWithRef(entry.note, channel, ref)) return true;
  }
  return false;
}
