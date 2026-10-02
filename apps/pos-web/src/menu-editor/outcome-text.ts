import { errorText, type Translate } from '../api/errors.ts';
import type { EditorOutcome } from './menu-editor-store.ts';

type Failure = Extract<EditorOutcome<unknown>, { ok: false }>;

/**
 * What to tell the person when a menu edit did not happen; null when there is nothing to say (a
 * second tap on a row that is already being saved, or an answer from before a sign-out). A stale
 * view adds that the latest data was loaded, so the person knows to look again before retrying.
 */
export function failureText(tr: Translate, failure: Failure): string | null {
  switch (failure.reason) {
    case 'busy':
    case 'stale':
      return null;
    case 'offline':
      return tr('menuEditor.offline');
    case 'photo':
      return tr(`menuEditor.photo.error.${failure.failure}`);
    case 'error': {
      const text = errorText(tr, failure.error);
      return failure.refreshed ? `${text} ${tr('menuEditor.refreshed')}` : text;
    }
  }
}
