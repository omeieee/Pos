/**
 * Who is this customer? The customer app sends a LIFF ID token or access token; this module asks
 * LINE whether it is genuine and for the LINE user id behind it. The user id the client might also
 * send is never read.
 *
 * The LIFF app lives on its own LINE Login channel (D-06), so the id to check the token against
 * is that channel's id, the numeric prefix of `LINE_LIFF_ID` (`1234567890-abcdefgh`), NOT
 * `LINE_CHANNEL_ID` (the Messaging API channel). A token issued for any other channel is refused.
 * No token or user id is logged. The display name and picture LINE already returns with the
 * same answer (the quota-free LIFF profile) are handed on so the shop can show the kitchen who a
 * LINE order is for (owner, 2026-10-12); they are never logged.
 */
import { z } from 'zod';

export type LiffCredential = { idToken: string } | { accessToken: string };

/** LINE could not be asked (timeout, 5xx, no network). A bad token is `null`, not this. */
export class LiffUnavailableError extends Error {
  constructor() {
    super('LINE could not verify the token right now');
    this.name = 'LiffUnavailableError';
  }
}

export interface LiffIdentity {
  userId: string;
  /** From LINE's own answer when the customer allowed the profile; absent otherwise. */
  displayName?: string;
  pictureUrl?: string;
}

export interface LiffVerifier {
  /** The LINE user (and profile, if given) behind a genuine token for our LIFF channel, or null for anything else. */
  verify(credential: LiffCredential): Promise<LiffIdentity | null>;
}

/** `1234567890-abcdefgh` gives `1234567890`; anything else is not a LIFF id and gives undefined. */
export function liffChannelId(liffId: string | undefined): string | undefined {
  return liffId === undefined ? undefined : /^(\d{5,})-[A-Za-z0-9]+$/.exec(liffId)?.[1];
}

const idTokenResponse = z.object({
  iss: z.string().optional(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.number()]),
  exp: z.number(),
  name: z.string().optional(),
  picture: z.string().optional(),
});
const accessTokenResponse = z.object({
  client_id: z.union([z.string(), z.number()]),
  expires_in: z.number(),
});
const profileResponse = z.object({
  userId: z.string().min(1),
  displayName: z.string().optional(),
  pictureUrl: z.string().optional(),
});

/** Only the fields LINE actually sent, so an absent name stays absent. */
const withProfile = (userId: string, name?: string, picture?: string): LiffIdentity => ({
  userId,
  ...(name ? { displayName: name } : {}),
  ...(picture ? { pictureUrl: picture } : {}),
});

export interface LiffVerifierOptions {
  /** The LIFF channel id, from `liffChannelId`. */
  channelId: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export function createLiffVerifier(options: LiffVerifierOptions): LiffVerifier {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? 'https://api.line.me';
  const timeoutMs = options.timeoutMs ?? 6000;
  const now = options.now ?? (() => new Date());

  /** 2xx: the JSON body. 4xx: null (LINE says the token is not good). Anything else: unavailable. */
  async function call(path: string, init: RequestInit): Promise<unknown | null> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LiffUnavailableError();
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new LiffUnavailableError();
      }
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429) return null;
    throw new LiffUnavailableError();
  }

  const sameChannel = (aud: string | number) => String(aud) === options.channelId;

  return {
    async verify(credential) {
      if ('idToken' in credential) {
        const body = new URLSearchParams({
          id_token: credential.idToken,
          client_id: options.channelId,
        });
        const raw = await call('/oauth2/v2.1/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        const parsed = idTokenResponse.safeParse(raw);
        // LINE already checked the signature, issuer and expiry; the audience and expiry are
        // checked again here so a changed or mocked answer cannot let another channel's token in.
        if (!parsed.success) return null;
        if (!sameChannel(parsed.data.aud)) return null;
        if (parsed.data.exp * 1000 <= now().getTime()) return null;
        if (parsed.data.iss !== undefined && parsed.data.iss !== 'https://access.line.me') {
          return null;
        }
        return withProfile(parsed.data.sub, parsed.data.name, parsed.data.picture);
      }

      const verified = accessTokenResponse.safeParse(
        await call(
          `/oauth2/v2.1/verify?${new URLSearchParams({ access_token: credential.accessToken })}`,
          {
            method: 'GET',
          },
        ),
      );
      if (!verified.success) return null;
      if (!sameChannel(verified.data.client_id) || verified.data.expires_in <= 0) return null;
      const profile = profileResponse.safeParse(
        await call('/v2/profile', {
          method: 'GET',
          headers: { authorization: `Bearer ${credential.accessToken}` },
        }),
      );
      return profile.success
        ? withProfile(profile.data.userId, profile.data.displayName, profile.data.pictureUrl)
        : null;
    },
  };
}
