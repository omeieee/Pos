import { translator } from '@sds/i18n';
import { describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { failureText } from './outcome-text.ts';

const th = translator('th');
const en = translator('en');

describe('failureText', () => {
  test('says nothing for a second tap or a stale answer', () => {
    expect(failureText(th, { ok: false, reason: 'busy' })).toBeNull();
    expect(failureText(th, { ok: false, reason: 'stale' })).toBeNull();
  });

  test('offline explains that edits are not kept for later', () => {
    expect(failureText(th, { ok: false, reason: 'offline' })).toBe(th('menuEditor.offline'));
    expect(failureText(en, { ok: false, reason: 'offline' })).toBe(en('menuEditor.offline'));
  });

  test('a photo failure has its own sentence for each reason', () => {
    for (const failure of ['unreadable', 'unsupported', 'too_big', 'metadata'] as const) {
      const text = failureText(th, { ok: false, reason: 'photo', failure });
      expect(text).toBe(th(`menuEditor.photo.error.${failure}`));
    }
  });

  test('a server refusal uses the mapped message, plus "latest data loaded" after a conflict', () => {
    const conflict = new ApiClientError('VERSION_CONFLICT', { status: 409 });
    expect(failureText(th, { ok: false, reason: 'error', error: conflict, refreshed: true })).toBe(
      `${th('error.versionConflict')} ${th('menuEditor.refreshed')}`,
    );
    const mismatch = new ApiClientError('REORDER_SET_MISMATCH', { status: 409 });
    expect(failureText(en, { ok: false, reason: 'error', error: mismatch, refreshed: true })).toBe(
      `${en('error.reorderMismatch')} ${en('menuEditor.refreshed')}`,
    );
    const other = new ApiClientError('PHOTO_TOO_LARGE', { status: 413 });
    expect(failureText(th, { ok: false, reason: 'error', error: other, refreshed: false })).toBe(
      th('error.photoTooLarge'),
    );
  });
});
