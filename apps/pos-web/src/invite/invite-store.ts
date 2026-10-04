/**
 * The invite page's state, outside React (D-23).
 *
 * - The token is in this closure and nowhere else: not in the state, not in storage, not in a log
 *   line or an error. The caller takes it out of the address bar first (`takeInviteToken`).
 * - `start()` runs the preview ONCE per token. A preview gives a new authenticator secret and only
 *   the last one shown can be confirmed, so a second call (a re-render, a double effect) would
 *   leave the person scanning a secret the server no longer accepts. A retry after a failed
 *   preview is explicit (`retry()`).
 * - Any link that cannot be used (unknown, expired, used, revoked) is one `invalid` phase with one
 *   message: the page says nothing about which. A wrong authenticator code (422) is not that: the
 *   form stays and the person tries the next code.
 * - The page makes only these two public calls; it never touches a session or a device token.
 */
import type { InvitePreviewResponse } from '@sds/shared';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { buildAccept, type InviteDraft } from './invite-model.ts';

export type InvitePhase =
  | 'loading'
  /** The form: preview read, waiting for the person (or a failed try, see `error`). */
  | 'ready'
  | 'submitting'
  /** Account made: the recovery codes are shown once. */
  | 'done'
  /** Unusable link: one generic message. */
  | 'invalid'
  /** The preview could not be read (offline, busy server): the person may retry. */
  | 'unavailable';

export interface InviteState {
  phase: InvitePhase;
  preview: InvitePreviewResponse | null;
  /** The last failure that keeps the form (wrong code, e-mail taken, busy, offline). */
  error: ApiClientError | null;
  recoveryCodes: readonly string[];
}

export interface InviteStore extends ReadableStore<InviteState> {
  /** Reads the invite once. A second call with the store already started does nothing. */
  start(token: string | null): void;
  /** After `unavailable`: asks again (this replaces the authenticator secret shown). */
  retry(): void;
  /** Sends the form. Resolves true when the account was made. */
  accept(draft: InviteDraft): Promise<boolean>;
}

export interface InviteDeps {
  api: Pick<ApiClient['auth'], 'invitePreview' | 'inviteAccept'>;
}

/**
 * Answers that mean "this link is no good". At the preview a refused body (the fragment was
 * garbage or too long: REQUEST_INVALID before the network, VALIDATION_ERROR from the server) is
 * the same. At the accept a 400 means a field was refused, not the link: the form stays.
 */
const UNUSABLE_AT_PREVIEW = [
  'INVITE_INVALID',
  'INVITE_ACCEPTED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'REQUEST_INVALID',
];
const UNUSABLE_AT_ACCEPT = ['INVITE_INVALID', 'INVITE_ACCEPTED', 'NOT_FOUND'];

const asApiError = (error: unknown): ApiClientError =>
  isApiClientError(error) ? error : new ApiClientError('NETWORK');

export function createInviteStore(deps: InviteDeps): InviteStore {
  const store = createStore<InviteState>({
    phase: 'loading',
    preview: null,
    error: null,
    recoveryCodes: [],
  });
  let token: string | null = null;
  let started = false;
  let submitting = false;

  async function preview(): Promise<void> {
    if (token === null) return;
    store.setState({ phase: 'loading', error: null });
    try {
      const answer = await deps.api.invitePreview({ token });
      store.setState({ phase: 'ready', preview: answer });
    } catch (error) {
      const failure = asApiError(error);
      store.setState(
        UNUSABLE_AT_PREVIEW.includes(failure.code)
          ? { phase: 'invalid', preview: null }
          : { phase: 'unavailable', error: failure },
      );
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    start(given) {
      if (started) return;
      started = true;
      if (given === null || given === '') {
        store.setState({ phase: 'invalid' });
        return;
      }
      token = given;
      void preview();
    },

    retry() {
      if (store.getState().phase === 'unavailable') void preview();
    },

    async accept(draft) {
      const current = store.getState();
      if (token === null || current.phase !== 'ready' || !current.preview || submitting) {
        return false;
      }
      const input = buildAccept(token, current.preview.role, draft);
      if (!input) return false;
      submitting = true;
      store.setState({ phase: 'submitting', error: null });
      try {
        const answer = await deps.api.inviteAccept(input);
        // The link is spent: forget it, and keep only what the page shows once.
        token = null;
        store.setState({ phase: 'done', recoveryCodes: answer.recoveryCodes, preview: null });
        return true;
      } catch (error) {
        const failure = asApiError(error);
        if (UNUSABLE_AT_ACCEPT.includes(failure.code)) {
          token = null;
          store.setState({ phase: 'invalid', preview: null });
        } else {
          // Wrong code (422), e-mail taken, busy, offline: the form stays as it is.
          store.setState({ phase: 'ready', error: failure });
        }
        return false;
      } finally {
        submitting = false;
      }
    },
  };
}
