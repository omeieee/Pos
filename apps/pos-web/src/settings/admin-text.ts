import { errorText, type Translate } from '../api/errors.ts';
import type { AdminOutcome } from './admin-store.ts';

type Failure = Extract<AdminOutcome<unknown>, { ok: false }>;

/**
 * What to tell the person when a devices or staff change did not happen; null when there is nothing
 * to say (a second tap on a change already on its way, or an answer from before a sign-out). A
 * step-up the person closed says the owner has to sign in, online. A lost answer says it is not known whether it worked; a conflict
 * adds that the latest list was loaded.
 */
export function adminFailureText(tr: Translate, failure: Failure): string | null {
  switch (failure.reason) {
    case 'busy':
    case 'stale':
      return null;
    case 'cancelled':
      return tr('error.ownerSignInNeeded');
    case 'offline':
      return tr('settings.offline');
    case 'error': {
      if (failure.uncertain) return tr('settings.admin.uncertain');
      const text = errorText(tr, failure.error);
      return failure.refreshed ? `${text} ${tr('settings.refreshed')}` : text;
    }
  }
}
