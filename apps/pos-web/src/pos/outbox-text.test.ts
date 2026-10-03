import { translator } from '@sds/i18n';
import { describe, expect, test } from 'vitest';
import { entryErrorText } from './outbox-text.ts';

const th = translator('th');
const en = translator('en');

describe('what a refused entry tells the person', () => {
  test('a reused request id says the system already has it and not to enter it again', () => {
    expect(entryErrorText(th, 'IDEMPOTENCY_KEY_REUSED')).toBe(th('outbox.error.alreadyThere'));
    expect(entryErrorText(en, 'IDEMPOTENCY_KEY_REUSED')).toBe(en('outbox.error.alreadyThere'));
  });

  test('an unknown staff member is the server’s own words, with the reason prefix', () => {
    expect(entryErrorText(th, 'UNKNOWN_STAFF')).toBe(
      th('outbox.refused', { reason: th('error.unknownStaff') }),
    );
  });
});
