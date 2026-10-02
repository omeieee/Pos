import { errorText, type Translate } from '../api/errors.ts';
import type { SaveOutcome } from './settings-store.ts';

type Failure = Extract<SaveOutcome<unknown>, { ok: false }>;

/**
 * What to tell the person when a settings change did not happen; null when there is nothing to say
 * (a second tap on a change already on its way, an answer from before a sign-out, or a step-up the
 * person closed). A conflict adds that the latest values were loaded, so the person knows to look
 * again before saving.
 */
export function failureText(tr: Translate, failure: Failure): string | null {
  switch (failure.reason) {
    case 'busy':
    case 'stale':
    case 'cancelled':
      return null;
    case 'offline':
      return tr('settings.offline');
    case 'error': {
      const text = errorText(tr, failure.error);
      return failure.refreshed ? `${text} ${tr('settings.refreshed')}` : text;
    }
  }
}
