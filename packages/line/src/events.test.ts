import { describe, expect, test } from 'vitest';
import { eventUserId, webhookBodySchema, webhookEventSchema } from './events.ts';
import { encodePostback, parsePostback } from './postback.ts';
import { routeEvent } from './router.ts';

const U = 'Utest0000000000000000000000000001';
const ORDER = '0191a8f0-0000-7000-8000-000000000001';
const source = { type: 'user', userId: U };
const parse = (e: unknown) => webhookEventSchema.parse(e);

describe('webhookEventSchema', () => {
  test('parses a follow event', () => {
    const e = parse({
      type: 'follow',
      webhookEventId: '01H',
      replyToken: 'rt',
      source,
      mode: 'active',
      deliveryContext: { isRedelivery: true },
    });
    expect(e.type).toBe('follow');
    expect(e.deliveryContext?.isRedelivery).toBe(true);
    expect(eventUserId(e)).toBe(U);
  });

  test('an unknown event type still parses (so a valid delivery is never a 4xx)', () => {
    const e = parse({ type: 'videoPlayComplete', webhookEventId: '01H', source });
    expect(e.type).toBe('videoPlayComplete');
  });

  test('an event without webhookEventId is rejected', () => {
    expect(webhookEventSchema.safeParse({ type: 'follow', replyToken: 'x' }).success).toBe(false);
  });

  test('the console Verify body has no events', () => {
    expect(webhookBodySchema.parse({ destination: 'U', events: [] }).events).toEqual([]);
  });

  test('a group source has no user id', () => {
    const e = parse({ type: 'unfollow', webhookEventId: '1', source: { type: 'group' } });
    expect(eventUserId(e)).toBeUndefined();
  });
});

describe('postback data', () => {
  test('round trips', () => {
    for (const a of [
      { action: 'ack_privacy' },
      { action: 'paid', orderId: ORDER },
      { action: 'change_method', orderId: ORDER },
    ] as const) {
      expect(parsePostback(encodePostback(a))).toEqual(a);
    }
  });

  test('rejects an unknown action, a bad order id, and junk', () => {
    expect(parsePostback(`action=refund&order=${ORDER}`)).toBeNull();
    expect(parsePostback('action=paid&order=1%20or%201=1')).toBeNull();
    expect(parsePostback('action=paid')).toBeNull();
    expect(parsePostback('')).toBeNull();
  });
});

describe('routeEvent', () => {
  const msg = (message: unknown) =>
    parse({ type: 'message', webhookEventId: '1', replyToken: 'rt', source, message });

  test('follow and unfollow', () => {
    expect(
      routeEvent(parse({ type: 'follow', webhookEventId: '1', replyToken: 'rt', source })),
    ).toEqual({ kind: 'follow', userId: U, replyToken: 'rt' });
    expect(routeEvent(parse({ type: 'unfollow', webhookEventId: '1', source }))).toEqual({
      kind: 'unfollow',
      userId: U,
    });
  });

  test('postbacks', () => {
    const pb = (data: string) =>
      parse({
        type: 'postback',
        webhookEventId: '1',
        replyToken: 'rt',
        source,
        postback: { data },
      });
    expect(routeEvent(pb('action=ack_privacy')).kind).toBe('ack_privacy');
    expect(routeEvent(pb(`action=paid&order=${ORDER}`))).toEqual({
      kind: 'payment_claimed',
      userId: U,
      orderId: ORDER,
      replyToken: 'rt',
    });
    expect(routeEvent(pb(`action=change_method&order=${ORDER}`)).kind).toBe('change_method');
    expect(routeEvent(pb('action=nope')).kind).toBe('ignore');
  });

  test('keywords match the whole trimmed text only', () => {
    expect(routeEvent(msg({ type: 'text', id: '1', text: ' สถานะ ' }))).toMatchObject({
      kind: 'keyword',
      keyword: 'status',
    });
    expect(routeEvent(msg({ type: 'text', id: '1', text: 'เมนู' }))).toMatchObject({
      keyword: 'menu',
    });
    expect(routeEvent(msg({ type: 'text', id: '1', text: 'ติดต่อ' }))).toMatchObject({
      keyword: 'contact',
    });
    expect(routeEvent(msg({ type: 'text', id: '1', text: 'สถานะอะไร' })).kind).toBe('ignore');
  });

  test('an image is a possible slip', () => {
    expect(routeEvent(msg({ type: 'image', id: '555' }))).toEqual({
      kind: 'slip_image',
      userId: U,
      messageId: '555',
      replyToken: 'rt',
    });
  });

  test('stickers, unknown types and events without a user are ignored', () => {
    expect(routeEvent(msg({ type: 'sticker', id: '1' })).kind).toBe('ignore');
    expect(routeEvent(parse({ type: 'beacon', webhookEventId: '1', source })).kind).toBe('ignore');
    expect(
      routeEvent(parse({ type: 'unfollow', webhookEventId: '1', source: { type: 'room' } })).kind,
    ).toBe('ignore');
  });
});
