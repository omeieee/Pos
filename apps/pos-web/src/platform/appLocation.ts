/**
 * Where the app is, as the browser reports it, behind one seam (the P10 shells serve the app from
 * their own origin and need a configured web address for links people open elsewhere).
 */

/** The public web address links are built on: `VITE_APP_ORIGIN` when set, else this page's origin. */
export function appOrigin(): string {
  const configured = import.meta.env.VITE_APP_ORIGIN;
  if (configured) return configured.replace(/\/+$/, '');
  return window.location.origin;
}

/** The link an owner sends to an invited person. The token stays in the fragment: never sent to a server. */
export function inviteLink(token: string): string {
  return `${appOrigin()}/invite#${token}`;
}

/** The invite page's address (path only, no fragment). */
export const INVITE_PATH = '/invite';

export const isInvitePath = (pathname: string): boolean =>
  pathname.replace(/\/+$/, '') === INVITE_PATH;

/**
 * Takes the invite token out of the address bar: returns it and replaces the address with the bare
 * path (no fragment), without adding a history entry. Returns null when there is none.
 */
export function takeInviteToken(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return raw === '' ? null : raw;
}
