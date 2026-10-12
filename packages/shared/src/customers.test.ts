import { describe, expect, test } from 'vitest';
import {
  ANONYMIZED_RECIPIENT_NAME,
  anonymizeCustomerInputSchema,
  anonymizeCustomerResponseSchema,
  recipientNameSchema,
  slipFlagClearInputSchema,
} from './index.ts';

describe('anonymising a customer (PDPA)', () => {
  test('the body is optional and the reason is one of a few fixed words, never free text', () => {
    expect(anonymizeCustomerInputSchema.safeParse({}).success).toBe(true);
    for (const reason of ['customer_request', 'retention', 'other']) {
      expect(anonymizeCustomerInputSchema.safeParse({ reason }).success, reason).toBe(true);
    }
    expect(
      anonymizeCustomerInputSchema.safeParse({ reason: 'Somchai asked on the phone' }).success,
    ).toBe(false);
    expect(anonymizeCustomerInputSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  test('the response carries an id, the time and the version, nothing personal', () => {
    const parsed = anonymizeCustomerResponseSchema.parse({
      id: '0192f3a0-0000-7000-8000-000000000001',
      anonymizedAt: '2026-10-02T03:00:00.000Z',
      version: 3,
      extra: 'dropped',
    });
    expect(Object.keys(parsed).sort()).toEqual(['anonymizedAt', 'id', 'version']);
  });

  test('the placeholder left on past orders is a valid recipient name, so the order check still holds', () => {
    expect(recipientNameSchema.safeParse(ANONYMIZED_RECIPIENT_NAME).success).toBe(true);
  });
});

describe('clearing a slip flag', () => {
  test('a request id and a reason of 1 to 200 characters, nothing else', () => {
    const clientRequestId = '0191a8f0-0000-7000-8000-000000000001';
    expect(slipFlagClearInputSchema.safeParse({ clientRequestId, reason: 'ok' }).success).toBe(
      true,
    );
    for (const bad of [
      {},
      { clientRequestId },
      { clientRequestId, reason: '' },
      { clientRequestId, reason: 'x'.repeat(201) },
      { clientRequestId, reason: 'ok', extra: 1 },
    ]) {
      expect(slipFlagClearInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
