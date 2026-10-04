import type { TextClipboard } from '../platform/clipboard.ts';
import { useApplyTokens } from '../theme/apply-tokens.ts';
import { InvitePage } from './InvitePage.tsx';
import type { InviteStore } from './invite-store.ts';

/**
 * The whole app for an invite link: just the invite page, with the design tokens. It has no
 * services, no sign-in gate, no realtime connection and no router (the hash router would rewrite
 * the address, and the address is where the token was).
 */
export function InviteApp({ store, clipboard }: { store: InviteStore; clipboard: TextClipboard }) {
  useApplyTokens(null);
  return <InvitePage store={store} clipboard={clipboard} />;
}
