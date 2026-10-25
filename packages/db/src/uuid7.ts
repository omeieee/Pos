/**
 * Monotonic UUIDv7 made in the app (RFC 9562 §6.2 method 1): 48-bit Unix ms timestamp, a 12-bit
 * counter in rand_a, then 62 random bits. The SQL default `uuid_generate_v7()` fills everything
 * after the timestamp at random, so rows written in the same millisecond sort in random order.
 * Ids from this function sort in the order they were made within this process, which keeps a
 * multi-row insert in its array order (order items in cart order).
 */

const COUNTER_MAX = 0xfff;

let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    counter += 1;
    if (counter > COUNTER_MAX) {
      // 4,096 ids in one millisecond: borrow the next one, so the order still holds.
      ms += 1;
      counter = randomStart();
    }
  } else {
    counter = randomStart();
  }
  lastMs = ms;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes.subarray(8));
  let t = ms;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random start in the lower half of the counter, so a busy millisecond still has room to count up. */
function randomStart(): number {
  const [value = 0] = crypto.getRandomValues(new Uint16Array(1));
  return value & 0x7ff;
}
