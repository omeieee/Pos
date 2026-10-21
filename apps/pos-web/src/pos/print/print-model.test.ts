import { ORDER_STATUSES } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { canReprint } from './print-model.ts';

describe('canReprint', () => {
  test.each(['new', 'preparing', 'ready', 'completed'] as const)(
    '%s can be reprinted',
    (status) => {
      expect(canReprint(status)).toBe(true);
    },
  );
  test('cancelled cannot', () => {
    expect(canReprint('cancelled')).toBe(false);
  });
  test('every status is decided', () => {
    expect(ORDER_STATUSES.filter(canReprint)).toHaveLength(ORDER_STATUSES.length - 1);
  });
});
