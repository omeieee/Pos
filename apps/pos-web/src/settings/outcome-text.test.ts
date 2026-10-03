import { translator } from '@sds/i18n';
import { describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { adminFailureText } from './admin-text.ts';
import { failureText } from './outcome-text.ts';

const th = translator('th');
const en = translator('en');

describe('a step-up the person closed is not silent', () => {
  test('a settings change says the owner has to sign in, online', () => {
    expect(failureText(th, { ok: false, reason: 'cancelled' })).toBe(th('error.ownerSignInNeeded'));
    expect(failureText(en, { ok: false, reason: 'cancelled' })).toBe(en('error.ownerSignInNeeded'));
  });

  test('so does a devices or staff change', () => {
    expect(adminFailureText(th, { ok: false, reason: 'cancelled' })).toBe(
      th('error.ownerSignInNeeded'),
    );
    expect(adminFailureText(en, { ok: false, reason: 'cancelled' })).toBe(
      en('error.ownerSignInNeeded'),
    );
  });

  test('a second tap and an answer from before a sign-out still say nothing', () => {
    for (const reason of ['busy', 'stale'] as const) {
      expect(failureText(th, { ok: false, reason })).toBeNull();
      expect(adminFailureText(th, { ok: false, reason })).toBeNull();
    }
  });

  test('the server’s own words for the co-pay channel refusal reach the settings form', () => {
    const error = new ApiClientError('COPAY_CHANNELS_NOT_STOREFRONT', { status: 422 });
    expect(failureText(th, { ok: false, reason: 'error', error, refreshed: false })).toBe(
      th('error.copayChannelsNotStorefront'),
    );
    expect(failureText(en, { ok: false, reason: 'error', error, refreshed: false })).toBe(
      en('error.copayChannelsNotStorefront'),
    );
  });
});
