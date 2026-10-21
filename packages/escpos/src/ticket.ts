/**
 * Draws a kitchen ticket as a raster image and wraps it in ESC/POS.
 *
 * WIDTH: 576 dots is 72 mm at 203 dpi, the usual printable width of an 80 mm head. The real
 * printable width of the Xprinter XP-80T (576, or 512 for some 80 mm models, or 384 on a 58 mm one)
 * MUST be confirmed on the device; that is why `widthDots` is a parameter. Everything is laid out
 * in proportion to the width.
 */
import type { KitchenTicket } from '@sds/shared';
import {
  type Bitmap,
  concatBytes,
  DEFAULT_BAND_HEIGHT,
  encodeRaster,
  FEED_AND_CUT,
  INIT_PRINTER,
} from './bitmap.ts';
import { Canvas, DEFAULT_THRESHOLD, type Ink } from './canvas.ts';
import { fontMetrics, measureText, shapeText } from './fonts.ts';
import { channelBadge, fulfillmentLabel, TICKET_TEXT, thaiDate } from './labels.ts';
import { wrapText } from './wrap.ts';

export const SUPPORTED_WIDTHS = [576, 512, 384] as const;
export type TicketWidth = (typeof SUPPORTED_WIDTHS)[number];

export interface RenderOptions {
  /** Printable width in dots. Default 576. */
  widthDots?: TicketWidth;
  /** Cut the paper at the end. Default true. */
  cut?: boolean;
  /** Dots at least this dark (0..1) print black. */
  threshold?: number;
  bandHeight?: number;
}

type Draw = (canvas: Canvas) => void;

/** Lays the ticket out top to bottom, then paints it on a canvas exactly as tall as it needs. */
export function drawTicket(ticket: KitchenTicket, widthDots: number = 576): Canvas {
  if (!SUPPORTED_WIDTHS.includes(widthDots as TicketWidth)) {
    throw new RangeError(`widthDots must be one of ${SUPPORTED_WIDTHS.join(', ')}`);
  }
  const k = widthDots / 576;
  const px = (value: number) => Math.round(value * k);
  const margin = px(12);
  const inner = widthDots - margin * 2;
  const metrics = fontMetrics();
  const lineGap = px(4);

  const ops: Draw[] = [];
  let y = px(8);

  const lineHeight = (size: number) =>
    Math.ceil((metrics.ascent + metrics.descent) * size) + lineGap;
  const baseline = (top: number, size: number) => top + Math.ceil(metrics.ascent * size);

  /** One or more wrapped lines starting at `x`; returns nothing, advances `y`. */
  const paragraph = (text: string, size: number, bold: boolean, x = margin, ink: Ink = 'black') => {
    for (const line of wrapText(text, size, bold, widthDots - margin - x)) {
      const top = y;
      const shaped = shapeText(line, size, bold);
      ops.push((c) => c.drawText(shaped, x, baseline(top, size), ink));
      y += lineHeight(size);
    }
  };
  const gap = (dots: number) => {
    y += px(dots);
  };
  const rule = () => {
    const top = y + px(4);
    ops.push((c) => c.dashedLine(margin, top, inner));
    y += px(14);
  };

  // Reprint banner: white text on a black bar.
  if (ticket.reprint) {
    const size = px(34);
    const barTop = y;
    const barHeight = lineHeight(size) + px(8);
    const shaped = shapeText(TICKET_TEXT.reprint(ticket.copy), size, true);
    const textX = margin + Math.max(0, (inner - shaped.width) / 2);
    ops.push((c) => {
      c.fillRect(margin, barTop, inner, barHeight);
      c.drawText(shaped, textX, baseline(barTop + px(4), size), 'white');
    });
    y += barHeight + px(8);
  }

  // Source badge (inverted) and the way it reaches the customer.
  {
    const size = px(38);
    const badgeText = channelBadge(ticket.channel);
    const badge = shapeText(badgeText, size, true);
    const pad = px(12);
    const badgeWidth = Math.ceil(badge.width) + pad * 2;
    const rowTop = y;
    const rowHeight = lineHeight(size) + px(6);
    const label = fulfillmentLabel(ticket.fulfillment);
    const labelSize = px(32);
    const labelWidth = widthDots - margin - (margin + badgeWidth + px(14));
    const labelLines = wrapText(label, labelSize, true, labelWidth);
    ops.push((c) => {
      c.fillRect(margin, rowTop, badgeWidth, rowHeight);
      c.drawText(badge, margin + pad, baseline(rowTop + px(3), size), 'white');
    });
    labelLines.forEach((line, index) => {
      const shaped = shapeText(line, labelSize, true);
      const top = rowTop + px(3) + index * lineHeight(labelSize);
      ops.push((c) => c.drawText(shaped, margin + badgeWidth + px(14), baseline(top, labelSize)));
    });
    y += Math.max(rowHeight, labelLines.length * lineHeight(labelSize) + px(6)) + px(4);
  }

  // Order number, as large as fits (the first thing the cook looks for).
  {
    let size = px(130);
    while (size > px(40) && measureText(ticket.orderNo, size, true) > inner) size -= px(4);
    const shaped = shapeText(ticket.orderNo, size, true);
    const top = y;
    const x = margin + Math.max(0, (inner - shaped.width) / 2);
    ops.push((c) => c.drawText(shaped, x, baseline(top, size)));
    y += lineHeight(size);
  }

  // Who it is for and where.
  const hasWho = ticket.who !== null || ticket.building !== null || ticket.roomNo !== null;
  if (hasWho) {
    rule();
    if (ticket.who) paragraph(`${TICKET_TEXT.who}: ${ticket.who}`, px(34), true);
    if (ticket.building) paragraph(`${TICKET_TEXT.building}: ${ticket.building}`, px(30), false);
    if (ticket.roomNo) paragraph(`${TICKET_TEXT.room}: ${ticket.roomNo}`, px(34), true);
  }
  rule();

  // Items: quantity in its own column, name and options hanging to the right of it.
  const itemSize = px(36);
  const detailSize = px(30);
  const qtyColumn = Math.ceil(measureText('99x', itemSize, true)) + px(10);
  const textX = margin + qtyColumn;
  if (ticket.lines.length === 0) paragraph(TICKET_TEXT.noItems, itemSize, false);
  for (const line of ticket.lines) {
    const qty = shapeText(`${line.qty}x`, itemSize, true);
    const top = y;
    ops.push((c) => c.drawText(qty, margin, baseline(top, itemSize)));
    paragraph(line.nameTh, itemSize, true, textX);
    for (const modifier of line.modifiers) paragraph(`+ ${modifier}`, detailSize, false, textX);
    if (line.note) paragraph(`* ${line.note}`, detailSize, true, textX);
    gap(8);
  }

  // Notes get a frame so they are not missed.
  const framed = (label: string, text: string) => {
    gap(4);
    const top = y;
    const pad = px(8);
    const before = y;
    y += pad;
    const size = px(30);
    for (const line of wrapText(`${label}: ${text}`, size, true, inner - pad * 2)) {
      const shaped = shapeText(line, size, true);
      const lineTop = y;
      ops.push((c) => c.drawText(shaped, margin + pad, baseline(lineTop, size)));
      y += lineHeight(size);
    }
    y += pad;
    const height = y - before;
    ops.push((c) => c.strokeRect(margin, top, inner, height, 2));
    gap(6);
  };
  if (ticket.deliveryNote) framed(TICKET_TEXT.deliveryNote, ticket.deliveryNote);
  if (ticket.orderNote) framed(TICKET_TEXT.orderNote, ticket.orderNote);

  // Time.
  rule();
  paragraph(
    `${TICKET_TEXT.placed} ${thaiDate(ticket.placedDate)} ${ticket.placedTime}`,
    px(28),
    false,
  );
  gap(16);

  const height = y + px(8);
  const canvas = new Canvas(widthDots, height);
  for (const op of ops) op(canvas);
  return canvas;
}

export function ticketBitmap(
  ticket: KitchenTicket,
  options: Pick<RenderOptions, 'widthDots' | 'threshold'> = {},
): Bitmap {
  return drawTicket(ticket, options.widthDots).toBitmap(options.threshold ?? DEFAULT_THRESHOLD);
}

/** The bytes to send to the printer (raw, port 9100) for one ticket. */
export function renderTicket(ticket: KitchenTicket, options: RenderOptions = {}): Uint8Array {
  const bitmap = ticketBitmap(ticket, options);
  return concatBytes([
    INIT_PRINTER,
    encodeRaster(bitmap, options.bandHeight ?? DEFAULT_BAND_HEIGHT),
    ...(options.cut === false ? [] : [FEED_AND_CUT]),
  ]);
}
