/**
 * The LIFF SDK behind a small interface (the same idea as the staff app's platform folder), so a
 * different shell or a test can swap it. The SDK is loaded from LINE's CDN when the app starts
 * (allowed by the page's CSP, `static.line-scdn.net`), which keeps it out of our own bundle.
 *
 * Needed LIFF scopes: `openid` (ID token, who the customer is), `profile`, and
 * `chat_message.write` (`sendMessages`, so the shop's confirmation goes out as a free reply).
 */
import type { Credential } from '../api/client.ts';

interface LiffSdk {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(): void;
  getIDToken(): string | null;
  getAccessToken(): string | null;
  isInClient(): boolean;
  sendMessages(messages: { type: 'text'; text: string }[]): Promise<void>;
}

declare global {
  interface Window {
    liff?: LiffSdk;
  }
}

export interface Platform {
  /** The token to trade for a session: the ID token, else the access token. */
  credential(): Credential | null;
  /** `sendMessages` only works when the app was opened from a chat or the rich menu. */
  canSendMessages(): boolean;
  /** Says something in the shop's chat as the customer. Failures are swallowed: it is a courtesy. */
  sendText(text: string): Promise<void>;
}

const SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

function loadSdk(): Promise<LiffSdk> {
  return new Promise((resolve, reject) => {
    if (window.liff) return resolve(window.liff);
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => (window.liff ? resolve(window.liff) : reject(new Error('liff missing')));
    script.onerror = () => reject(new Error('liff failed to load'));
    document.head.append(script);
  });
}

/** Starts LIFF. Sends the person to LINE login when they are not signed in (the page then reloads). */
export async function startPlatform(liffId: string | undefined): Promise<Platform> {
  if (!liffId) throw new Error('VITE_LIFF_ID is not set');
  const liff = await loadSdk();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return new Promise<Platform>(() => {});
  }
  return {
    credential() {
      const idToken = liff.getIDToken();
      if (idToken) return { idToken };
      const accessToken = liff.getAccessToken();
      return accessToken ? { accessToken } : null;
    },
    canSendMessages: () => liff.isInClient(),
    async sendText(text) {
      try {
        await liff.sendMessages([{ type: 'text', text }]);
      } catch {
        // The order is already placed; the chat confirmation is a courtesy.
      }
    },
  };
}
