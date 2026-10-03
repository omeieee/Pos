/**
 * The customer app's API client. Types come from `@sds/shared` (type-only imports, so the schema
 * library is not bundled); the server is the authority on every rule and every amount.
 *
 * Sign-in: the LIFF credential is traded for a short-lived session token (`POST /v1/app/session`).
 * The token is kept in memory only. A 401 on any call gets one fresh sign-in and one retry.
 */
import type {
  AppOrderInput,
  AppOrderResult,
  AppPayMethod,
  CheckoutInfo,
  CustomerSessionResponse,
  MyOrder,
  MyOrdersResponse,
  MyQrResponse,
  PrivacyAckResponse,
  PublicMenuResponse,
} from '@sds/shared';

export type Credential = { idToken: string } | { accessToken: string };

/** A failed call: the HTTP status and the API's own error code (or a client-side word). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiFailure';
  }
}

export interface ApiOptions {
  baseUrl: string;
  credential: () => Credential | null;
  fetch?: typeof fetch;
}

const join = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export function createApi(options: ApiOptions) {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let session: { token: string; acknowledged: boolean } | null = null;

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(join(options.baseUrl, path), init);
    } catch {
      throw new ApiFailure(0, 'NETWORK');
    }
  }

  async function failure(response: Response): Promise<ApiFailure> {
    let code = 'ERROR';
    try {
      const body = (await response.json()) as { code?: unknown };
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // not JSON: keep the generic code
    }
    return new ApiFailure(response.status, code);
  }

  async function signIn(): Promise<CustomerSessionResponse> {
    const credential = options.credential();
    if (!credential) throw new ApiFailure(401, 'NO_CREDENTIAL');
    const response = await send('/v1/app/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
    });
    if (!response.ok) throw await failure(response);
    const body = (await response.json()) as CustomerSessionResponse;
    session = { token: body.token, acknowledged: body.privacyAcknowledged };
    return body;
  }

  async function authed<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    if (!session) await signIn();
    const response = await send(path, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${session?.token ?? ''}`,
      },
    });
    if (response.status === 401 && !retried) {
      session = null;
      return authed<T>(path, init, true);
    }
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  const post = <T>(path: string, body?: unknown) =>
    authed<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    /** The public menu for the LINE channel: LINE prices, nothing sold out, no costs. */
    async menu(): Promise<PublicMenuResponse> {
      const response = await send('/v1/menu?channel=line', { method: 'GET' });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as PublicMenuResponse;
    },
    signIn,
    checkout: () => authed<CheckoutInfo>('/v1/app/checkout'),
    acknowledgePrivacy: () => post<PrivacyAckResponse>('/v1/app/privacy-ack'),
    placeOrder: (input: AppOrderInput) => post<AppOrderResult>('/v1/app/orders', input),
    orders: () => authed<MyOrdersResponse>('/v1/app/orders'),
    order: (id: string) => authed<MyOrder>(`/v1/app/orders/${id}`),
    selectPayment: (id: string, method: AppPayMethod) =>
      post<MyOrder>(`/v1/app/orders/${id}/payment`, {
        method,
        clientRequestId: crypto.randomUUID(),
      }),
    claim: (id: string) => post<MyOrder>(`/v1/app/orders/${id}/claim`),
    /** A fresh link every time: it lasts five minutes. `url` is relative to the API origin. */
    qr: (id: string) => authed<MyQrResponse>(`/v1/app/orders/${id}/qr`),
    /** Where an `<img>` loads the QR picture from. */
    absolute: (path: string) => join(options.baseUrl, path),
  };
}

export type Api = ReturnType<typeof createApi>;
