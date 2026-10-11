import { describe, expect, test } from 'vitest';
import { STAFF_ROLES } from './enums.ts';
import { redactOrderForRole } from './order-privacy.ts';
import type { OrderDto } from './orders.ts';
import { hasPermission } from './permissions.ts';

const order = {
  member: { fullName: 'Test Person', nickname: 'Tee', building: 'B1', phone: '0812345678' },
  line: { displayName: 'Tee Test', pictureUrl: 'https://profile.line-scdn.net/p' },
} as unknown as OrderDto;

describe('redactOrderForRole', () => {
  test('the kitchen gets no phone number, and everything else stays', () => {
    const out = redactOrderForRole('kitchen', order);
    expect(out.member).toEqual({
      fullName: 'Test Person',
      nickname: 'Tee',
      building: 'B1',
      phone: null,
    });
    expect(out.line).toEqual(order.line);
  });

  test('every role that may take orders keeps the phone', () => {
    for (const role of STAFF_ROLES) {
      const out = redactOrderForRole(role, order);
      expect(out.member?.phone).toBe(hasPermission(role, 'order.create') ? '0812345678' : null);
    }
  });

  test('does not change the order it was given, and passes an order with no member through', () => {
    redactOrderForRole('kitchen', order);
    expect(order.member?.phone).toBe('0812345678');
    const bare = { member: null } as unknown as OrderDto;
    expect(redactOrderForRole('kitchen', bare)).toBe(bare);
  });
});
