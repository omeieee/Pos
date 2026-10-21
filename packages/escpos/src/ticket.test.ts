import { type KitchenTicket, kitchenTicketSchema } from '@sds/shared';
import { describe, expect, it } from 'vitest';
import { FEED_AND_CUT, INIT_PRINTER } from './bitmap.ts';
import { measureText, shapeText } from './fonts.ts';
import { SAMPLE_TICKET } from './sample.ts';
import { renderTicket, ticketBitmap } from './ticket.ts';
import { wrapText } from './wrap.ts';

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, i) => bytes[i] === byte);

describe('sample ticket', () => {
  it('is a valid ticket (so the test print matches what the API sends)', () => {
    expect(kitchenTicketSchema.safeParse(SAMPLE_TICKET).success).toBe(true);
  });
});

describe('Thai shaping', () => {
  const top = (path: ReturnType<typeof shapeText>['glyphs'][number]['path']) =>
    Math.max(...path.flatMap((c) => c.args.filter((_, i) => i % 2 === 1)));

  it('gives a combining tone mark no advance and puts it above the consonant', () => {
    const plain = shapeText('ก', 40, false);
    const toned = shapeText('ก้', 40, false); // ก + ไม้โท
    expect(toned.glyphs.length).toBe(2);
    expect(toned.width).toBeCloseTo(plain.width, 5);
    const [base, mark] = toned.glyphs;
    expect(base && mark && top(mark.path) > top(base.path)).toBe(true);
  });

  it('stacks a tone mark on an above vowel (ที่) without widening it', () => {
    const base = shapeText('ที', 40, true);
    const stacked = shapeText('ที่', 40, true);
    expect(stacked.glyphs.length).toBe(3);
    expect(stacked.width).toBeCloseTo(base.width, 5);
  });

  it('measures Latin digits and Thai, bold at least as wide as regular', () => {
    expect(measureText('L-012', 40, false)).toBeGreaterThan(0);
    expect(measureText('สวัสดี', 40, true)).toBeGreaterThanOrEqual(
      measureText('สวัสดี', 40, false) - 1,
    );
  });
});

describe('wrapText', () => {
  it('breaks Thai at word boundaries and keeps every line within the width', () => {
    const text = 'ก๋วยเตี๋ยวต้มยำหมูสับไม่ใส่ผักชีเส้นเล็กน้ำน้อย';
    const lines = wrapText(text, 36, false, 300);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 36, false)).toBeLessThanOrEqual(300);
    expect(lines.join('')).toBe(text);
  });

  it('never starts a line with a combining mark when it has to cut inside a word', () => {
    const text = 'ก่'.repeat(20);
    const lines = wrapText(text, 36, false, 120);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.codePointAt(0)).not.toBe(0x0e48);
  });

  it('keeps explicit line breaks', () => {
    expect(wrapText('a\nb', 30, false, 500)).toEqual(['a', 'b']);
  });
});

describe('renderTicket', () => {
  it('starts with init, ends with feed-and-cut, and holds GS v 0 raster blocks', () => {
    const bytes = renderTicket(SAMPLE_TICKET);
    expect(startsWith(bytes, [...INIT_PRINTER, 0x1d, 0x76, 0x30, 0x00, 72, 0])).toBe(true);
    expect([...bytes.slice(-FEED_AND_CUT.length)]).toEqual([...FEED_AND_CUT]);
  });

  it('can leave the cut out', () => {
    const bytes = renderTicket(SAMPLE_TICKET, { cut: false });
    expect([...bytes.slice(-4)]).not.toEqual([...FEED_AND_CUT]);
  });

  it('honours the width: 576, 512 and 384 dots wide', () => {
    for (const [widthDots, widthBytes] of [
      [576, 72],
      [512, 64],
      [384, 48],
    ] as const) {
      const bytes = renderTicket(SAMPLE_TICKET, { widthDots });
      expect(bytes[INIT_PRINTER.length + 4]).toBe(widthBytes);
      expect(ticketBitmap(SAMPLE_TICKET, { widthDots }).width).toBe(widthDots);
    }
  });

  it('rejects an unsupported width', () => {
    expect(() => renderTicket(SAMPLE_TICKET, { widthDots: 500 as 576 })).toThrow(RangeError);
  });

  it('is deterministic', () => {
    expect(renderTicket(SAMPLE_TICKET)).toEqual(renderTicket(SAMPLE_TICKET));
  });

  it('prints ink, and leaves the outer margins as paper', () => {
    const bitmap = ticketBitmap(SAMPLE_TICKET);
    expect(bitmap.data.reduce((sum, dot) => sum + dot, 0)).toBeGreaterThan(5000);
    for (let y = 0; y < bitmap.height; y++) {
      for (const x of [0, 1, 2, 3, 4, 5, 570, 571, 572, 573, 574, 575]) {
        expect(bitmap.data[y * bitmap.width + x]).toBe(0);
      }
    }
  });

  it('is taller for a ticket with more lines, and a reprint adds a banner', () => {
    const base = ticketBitmap(SAMPLE_TICKET).height;
    const more: KitchenTicket = {
      ...SAMPLE_TICKET,
      lines: [...SAMPLE_TICKET.lines, ...SAMPLE_TICKET.lines],
    };
    expect(ticketBitmap(more).height).toBeGreaterThan(base);
    expect(ticketBitmap({ ...SAMPLE_TICKET, reprint: true, copy: 1 }).height).toBeGreaterThan(base);
  });

  it('handles a bare ticket (no name, no notes, no items) and a very long order number', () => {
    const bare: KitchenTicket = {
      ...SAMPLE_TICKET,
      orderNo: 'WALK-IN-2026-1022-0001',
      who: null,
      building: null,
      roomNo: null,
      deliveryNote: null,
      orderNote: null,
      lines: [],
    };
    const bitmap = ticketBitmap(bare);
    expect(bitmap.width).toBe(576);
    expect(bitmap.height).toBeGreaterThan(100);
  });

  it('handles every channel and fulfillment without throwing', () => {
    for (const channel of ['storefront', 'line', 'grab', 'lineman', 'phone'] as const) {
      for (const fulfillment of [
        'dine_in',
        'takeaway',
        'pickup',
        'room_delivery',
        'platform_delivery',
        'entrance_delivery',
      ] as const) {
        expect(() => renderTicket({ ...SAMPLE_TICKET, channel, fulfillment })).not.toThrow();
      }
    }
  });
});
