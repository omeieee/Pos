/**
 * Typed client for the /v1 API. The one place that talks HTTP to it.
 *
 * - Every success response is parsed with the shared Zod schema; a body that does not match is a
 *   RESPONSE_INVALID error, never silently used. Every request body is parsed with the shared
 *   input schema first, so an invalid call fails before it reaches the network.
 * - Tokens go in headers only: `Authorization: Bearer <session>` and `X-Device-Token`. They are
 *   never put in a URL, a log line or an error. The client reads them through getters so it
 *   holds no copy.
 * - `POST /v1/orders` carries `clientRequestId` (the idempotency key) in the body and the same
 *   value in `Idempotency-Key`. The id belongs to the logical order, not to one HTTP attempt: a
 *   caller that may retry (the offline outbox) creates it once with `newClientRequestId()` and
 *   passes it on every attempt.
 * - Only requests with a body send `Content-Type: application/json`; Fastify answers 400 to an
 *   empty JSON body (for example on POST /v1/auth/logout).
 */
import {
  acceptInviteInputSchema,
  acceptInviteResponseSchema,
  authMeResponseSchema,
  authStaffListResponseSchema,
  availabilityInputSchema,
  businessDaySettingsSchema,
  cancelOrderInputSchema,
  categoryDtoSchema,
  changePaymentMethodInputSchema,
  changePaymentMethodResultSchema,
  changeRoleInputSchema,
  claimPaymentInputSchema,
  confirmPaymentInputSchema,
  createCategoryInputSchema,
  createGroupInputSchema,
  createInviteInputSchema,
  createInviteResponseSchema,
  createItemInputSchema,
  createOptionInputSchema,
  createOrderInputSchema,
  createPaymentInputSchema,
  createStaffInputSchema,
  deliveryPatchInputSchema,
  deliverySettingsSchema,
  deviceDtoSchema,
  govCopayPatchInputSchema,
  govCopayResponseSchema,
  groupDtoSchema,
  idParamSchema,
  invitePreviewInputSchema,
  invitePreviewResponseSchema,
  itemDtoSchema,
  listDevicesResponseSchema,
  listInvitesResponseSchema,
  listOrdersQuerySchema,
  listOrdersResponseSchema,
  listStaffResponseSchema,
  maskPromptpayId,
  menuCostsResponseSchema,
  numberingPatchInputSchema,
  type OutboxRecoveryInput,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  optionDtoSchema,
  orderDtoSchema,
  orderIdParamSchema,
  orderPaymentsResponseSchema,
  outboxRecoveryInputSchema,
  outboxRecoveryResponseSchema,
  ownerLoginInputSchema,
  ownerStepUpInputSchema,
  patchCategoryInputSchema,
  patchGroupInputSchema,
  patchItemInputSchema,
  patchOptionInputSchema,
  patchOrderInputSchema,
  patchStaffInputSchema,
  paymentIdParamSchema,
  paymentQrUrlResponseSchema,
  paymentReasonInputSchema,
  paymentResultSchema,
  paymentsPatchInputSchema,
  paymentsSettingsSchema,
  pinLoginInputSchema,
  promptpayPatchInputSchema,
  promptpaySettingsSchema,
  publicMenuQuerySchema,
  publicMenuResponseSchema,
  recipientsQuerySchema,
  recipientsResponseSchema,
  registerDeviceInputSchema,
  registerDeviceResponseSchema,
  reorderInputSchema,
  reorderResponseSchema,
  sessionResponseSchema,
  setStaffPinInputSchema,
  settingResponseSchema,
  shopPatchInputSchema,
  shopSettingsSchema,
  staffDtoSchema,
  staffStepUpInputSchema,
  stepUpResponseSchema,
  syncQuerySchema,
  syncResponseSchema,
  transitionOrderInputSchema,
} from '@sds/shared';
import { z } from 'zod';
import { joinUrl } from '../platform/config.ts';
import { newUuid } from '../platform/ids.ts';
import { ApiClientError, AUTH_FAILURE_CODES, codeFromStatus, type LineError } from './errors.ts';

/** Structural slice of a Zod schema, so a failed parse can never leak its issues or the input. */
export interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getSessionToken: () => string | null;
  getDeviceToken: () => string | null;
  /**
   * Called when the API says the session or device is no longer valid (UNAUTHENTICATED on a
   * request that carried a session, DEVICE_UNREGISTERED, DEVICE_MISMATCH). The auth store
   * reacts here so every caller gets the same sign-out behaviour.
   */
  onAuthFailure?: (error: ApiClientError) => void;
  /** Milliseconds before a request is abandoned. The counter flow must never hang. */
  timeoutMs?: number;
}

type DeviceHeader = 'omit' | 'optional' | 'required';

interface RequestSpec<T> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** A file sent as it is (a menu photo): sent with `contentType` instead of JSON. */
  rawBody?: { data: Blob; contentType: string };
  schema?: Schema<T>;
  /** `true`: bearer from the store. A string: use this token (logout, after local clear). */
  session?: boolean | string;
  device?: DeviceHeader;
  headers?: Record<string, string>;
}

interface Raw<T> {
  data: T;
  status: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `details.errors` of a refused order: keeps code and line index only, at most 50 of them. */
function lineErrorsOf(value: unknown): LineError[] {
  if (!Array.isArray(value)) return [];
  const found: LineError[] = [];
  for (const entry of value.slice(0, 50)) {
    if (!isRecord(entry)) continue;
    const { code, lineIndex } = entry;
    if (typeof code === 'string' && code.length <= 64 && Number.isInteger(lineIndex)) {
      found.push({ code, lineIndex: lineIndex as number });
    }
  }
  return found;
}

/** Builds the error from a non-2xx answer, keeping only the fields the UI uses. */
function errorFromResponse(status: number, text: string): ApiClientError {
  const body = parseJson(text);
  const record = isRecord(body) ? body : {};
  const details = isRecord(record.details) ? record.details : {};
  const code =
    typeof record.code === 'string' && record.code.length > 0 && record.code.length <= 64
      ? record.code
      : codeFromStatus(status);

  const seconds = positiveNumber(details.retryAfterSeconds);
  const millis = positiveNumber(details.retryAfterMs);
  const wait = seconds ?? (millis === null ? null : millis / 1000);
  const version = positiveNumber(details.currentVersion);
  return new ApiClientError(code, {
    status,
    retryAfterSeconds: wait === null ? null : Math.min(MAX_WAIT_SECONDS, Math.ceil(wait)),
    currentVersion: version === null ? null : Math.floor(version),
    lineErrors: lineErrorsOf(details.errors),
  });
}

/** Parses request input with the shared schema, or fails before any network call. */
function checked<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiClientError('REQUEST_INVALID');
  return result.data;
}

export function newClientRequestId(): string {
  return newUuid();
}

export type NewOrderInput = Omit<z.input<typeof createOrderInputSchema>, 'clientRequestId'>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'clientRequestId'> : never;
export type NewPaymentInput = WithoutRequestId<z.input<typeof createPaymentInputSchema>>;
export type ChangePaymentInput = WithoutRequestId<z.input<typeof changePaymentMethodInputSchema>>;

export type NewCategoryInput = Omit<z.input<typeof createCategoryInputSchema>, 'clientRequestId'>;
export type NewItemInput = Omit<z.input<typeof createItemInputSchema>, 'clientRequestId'>;
export type NewGroupInput = Omit<z.input<typeof createGroupInputSchema>, 'clientRequestId'>;
export type NewOptionInput = Omit<z.input<typeof createOptionInputSchema>, 'clientRequestId'>;

const categoryListSchema = z.object({ categories: z.array(categoryDtoSchema) });
const itemListSchema = z.object({ items: z.array(itemDtoSchema) });
const groupListSchema = z.object({ groups: z.array(groupDtoSchema) });
export type OwnerLoginRequest = z.input<typeof ownerLoginInputSchema>;
export type OwnerStepUpRequest = z.input<typeof ownerStepUpInputSchema>;

export function createApiClient(options: ApiClientOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init as RequestInit));

  function buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = options.baseUrl.replace(/\/+$/, '');
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, value);
    }
    const qs = search.toString();
    return `${base}${path}${qs ? `?${qs}` : ''}`;
  }

  async function request<T>(spec: RequestSpec<T>): Promise<Raw<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };

    let bearer: string | null = null;
    if (spec.session) {
      bearer = typeof spec.session === 'string' ? spec.session : options.getSessionToken();
      // No session: say so without a round trip.
      if (!bearer) throw new ApiClientError('UNAUTHENTICATED', { status: 401 });
      headers.Authorization = `Bearer ${bearer}`;
    }

    const deviceMode = spec.device ?? 'omit';
    if (deviceMode !== 'omit') {
      const deviceToken = options.getDeviceToken();
      if (deviceToken) headers['X-Device-Token'] = deviceToken;
      else if (deviceMode === 'required') {
        throw new ApiClientError('DEVICE_UNREGISTERED', { status: 401 });
      }
    }

    let body: string | Blob | undefined;
    if (spec.rawBody) {
      headers['Content-Type'] = spec.rawBody.contentType;
      body = spec.rawBody.data;
    } else if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let text: string;
    try {
      const init: RequestInit = {
        method: spec.method,
        headers,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      };
      if (body !== undefined) init.body = body;
      const response = await doFetch(buildUrl(spec.path, spec.query), init);
      status = response.status;
      text = status === 204 ? '' : await response.text();
    } catch {
      // Never keep the original error: its message can carry the URL.
      throw new ApiClientError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      const error = errorFromResponse(status, text);
      const authFailure =
        AUTH_FAILURE_CODES.includes(error.code) &&
        (error.code !== 'UNAUTHENTICATED' || bearer !== null);
      if (authFailure) {
        try {
          options.onAuthFailure?.(error);
        } catch {
          // a failing listener must not hide the real error
        }
      }
      throw error;
    }

    if (!spec.schema) return { data: undefined as T, status };
    const parsed = spec.schema.safeParse(parseJson(text));
    if (!parsed.success) throw new ApiClientError('RESPONSE_INVALID', { status });
    return { data: parsed.data, status };
  }

  const get = <T>(spec: Omit<RequestSpec<T>, 'method'>) => request({ ...spec, method: 'GET' });
  const post = <T>(spec: Omit<RequestSpec<T>, 'method'>) => request({ ...spec, method: 'POST' });
  const patch = <T>(spec: Omit<RequestSpec<T>, 'method'>) => request({ ...spec, method: 'PATCH' });
  const put = <T>(spec: Omit<RequestSpec<T>, 'method'>) => request({ ...spec, method: 'PUT' });
  const del = <T>(spec: Omit<RequestSpec<T>, 'method'>) => request({ ...spec, method: 'DELETE' });
  const menuId = (id: string) => checked(idParamSchema, { id }).id;
  const orderPath = (id: string) => `/v1/orders/${checked(orderIdParamSchema, { id }).id}`;

  const auth = {
    /** The PIN screen's tiles. Needs this device's token, no session. */
    listStaff: async () =>
      (
        await get({
          path: '/v1/auth/staff',
          schema: authStaffListResponseSchema,
          device: 'required',
        })
      ).data,

    pinLogin: async (input: z.input<typeof pinLoginInputSchema>) =>
      (
        await post({
          path: '/v1/auth/pin',
          body: checked(pinLoginInputSchema, input),
          schema: sessionResponseSchema,
          device: 'required',
        })
      ).data,

    /**
     * Owner password sign-in. The device token is sent when there is one (the session is then
     * recorded against the device) but the call also works on an unregistered device.
     */
    ownerLogin: async (input: OwnerLoginRequest) =>
      (
        await post({
          path: '/v1/auth/owner',
          body: checked(ownerLoginInputSchema, input),
          schema: sessionResponseSchema,
          device: 'optional',
        })
      ).data,

    /** Owner + a fresh step-up. The one-time device token is in the answer; keep it. */
    registerDevice: async (input: z.input<typeof registerDeviceInputSchema>) =>
      (
        await post({
          path: '/v1/auth/device',
          body: checked(registerDeviceInputSchema, input),
          schema: registerDeviceResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** The owner's step-up: password plus an app code or a recovery code. */
    stepUpOwner: async (input: OwnerStepUpRequest) =>
      (
        await post({
          path: '/v1/auth/step-up',
          body: checked(ownerStepUpInputSchema, input),
          schema: stepUpResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Any other role's step-up: the PIN again. */
    stepUpStaff: async (input: z.input<typeof staffStepUpInputSchema>) =>
      (
        await post({
          path: '/v1/auth/step-up',
          body: checked(staffStepUpInputSchema, input),
          schema: stepUpResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The invite link's two public calls (D-23): the token in the body is the only credential, so
     * no session and no device token travel with them. The token is never put in a URL or an
     * error. A preview replaces the authenticator secret stored for the invite: call it once.
     */
    invitePreview: async (input: z.input<typeof invitePreviewInputSchema>) =>
      (
        await post({
          path: '/v1/auth/invite/preview',
          body: checked(invitePreviewInputSchema, input),
          schema: invitePreviewResponseSchema,
        })
      ).data,

    inviteAccept: async (input: z.input<typeof acceptInviteInputSchema>) =>
      (
        await post({
          path: '/v1/auth/invite/accept',
          body: checked(acceptInviteInputSchema, input),
          schema: acceptInviteResponseSchema,
        })
      ).data,

    me: async () =>
      (
        await get({
          path: '/v1/auth/me',
          schema: authMeResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** `sessionToken` lets the store clear its own copy first and still revoke this session. */
    logout: async (sessionToken?: string) => {
      await post<void>({
        path: '/v1/auth/logout',
        session: sessionToken ?? true,
        device: 'optional',
      });
    },
  };

  const orders = {
    /**
     * Creates an order. Pass the same `clientRequestId` on every retry of the same order; the
     * server then returns the original (`replay: true`). Without one, a fresh id is used.
     */
    create: async (input: NewOrderInput, options?: { clientRequestId?: string }) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: '/v1/orders',
        body: checked(createOrderInputSchema, { ...input, clientRequestId }),
        schema: orderDtoSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { order: data, replay: status === 200, clientRequestId };
    },

    list: async (query: z.input<typeof listOrdersQuerySchema> = {}) =>
      (
        await get({
          path: '/v1/orders',
          query: checked(listOrdersQuerySchema, query),
          schema: listOrdersResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    get: async (id: string) =>
      (
        await get({
          path: orderPath(id),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Note and room only; `expectedVersion` is required (VERSION_CONFLICT on a stale one). */
    patch: async (id: string, input: z.input<typeof patchOrderInputSchema>) =>
      (
        await patch({
          path: orderPath(id),
          body: checked(patchOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    transition: async (id: string, input: z.input<typeof transitionOrderInputSchema>) =>
      (
        await post({
          path: `${orderPath(id)}/transition`,
          body: checked(transitionOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    cancel: async (id: string, input: z.input<typeof cancelOrderInputSchema>) =>
      (
        await post({
          path: `${orderPath(id)}/cancel`,
          body: checked(cancelOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
  };

  const menu = {
    /** What can be ordered on a channel: public, no session. Sold-out items are NOT in it. */
    publicMenu: async (channel: z.input<typeof publicMenuQuerySchema>['channel'] = 'storefront') =>
      (
        await get({
          path: '/v1/menu',
          query: checked(publicMenuQuerySchema, { channel }) as Record<string, string>,
          schema: publicMenuResponseSchema,
        })
      ).data,

    /** The staff lists keep sold-out rows (every role may read them). */
    listCategories: async () =>
      (
        await get({
          path: '/v1/menu/categories',
          schema: categoryListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** `includeArchived` is for roles with `menu.edit` (anyone else gets 403). */
    listItems: async (options: { includeArchived?: boolean } = {}) =>
      (
        await get({
          path: '/v1/menu/items',
          ...(options.includeArchived ? { query: { includeArchived: 'true' } } : {}),
          schema: itemListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    listGroups: async (options: { includeArchived?: boolean } = {}) =>
      (
        await get({
          path: '/v1/menu/modifier-groups',
          ...(options.includeArchived ? { query: { includeArchived: 'true' } } : {}),
          schema: groupListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    // ----- The menu editor (`menu.edit`) -----
    // Every create carries `clientRequestId` (body and `Idempotency-Key`). The id belongs to the
    // logical create: a caller that may retry makes it once and passes it on every attempt.
    // Every patch needs the `expectedVersion` the editor saw (409 VERSION_CONFLICT otherwise).

    createCategory: async (input: NewCategoryInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/categories', createCategoryInputSchema, categoryDtoSchema, input, options),

    patchCategory: async (id: string, input: z.input<typeof patchCategoryInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/categories/${menuId(id)}`,
          body: checked(patchCategoryInputSchema, input),
          schema: categoryDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createItem: async (input: NewItemInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/items', createItemInputSchema, itemDtoSchema, input, options),

    patchItem: async (id: string, input: z.input<typeof patchItemInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/items/${menuId(id)}`,
          body: checked(patchItemInputSchema, input),
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** The sold-out switch (หมด). */
    setItemAvailable: async (id: string, input: z.input<typeof availabilityInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/items/${menuId(id)}/availability`,
          body: checked(availabilityInputSchema, input),
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createGroup: async (input: NewGroupInput, options?: { clientRequestId?: string }) =>
      create('/v1/menu/modifier-groups', createGroupInputSchema, groupDtoSchema, input, options),

    patchGroup: async (id: string, input: z.input<typeof patchGroupInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-groups/${menuId(id)}`,
          body: checked(patchGroupInputSchema, input),
          schema: groupDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    createOption: async (
      groupId: string,
      input: NewOptionInput,
      options?: { clientRequestId?: string },
    ) =>
      create(
        `/v1/menu/modifier-groups/${menuId(groupId)}/options`,
        createOptionInputSchema,
        optionDtoSchema,
        input,
        options,
      ),

    patchOption: async (id: string, input: z.input<typeof patchOptionInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-options/${menuId(id)}`,
          body: checked(patchOptionInputSchema, input),
          schema: optionDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    setOptionAvailable: async (id: string, input: z.input<typeof availabilityInputSchema>) =>
      (
        await patch({
          path: `/v1/menu/modifier-options/${menuId(id)}/availability`,
          body: checked(availabilityInputSchema, input),
          schema: optionDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** One sibling set in its new order, atomically. Idempotent: no request id. */
    reorder: async (input: z.input<typeof reorderInputSchema>) =>
      (
        await post({
          path: '/v1/menu/reorder',
          body: checked(reorderInputSchema, input),
          schema: reorderResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The costs of items and options, for roles with `report.view`. They are in no other answer
     * and in nothing the app saves: keep them in memory, for the editor only.
     */
    costs: async () =>
      (
        await get({
          path: '/v1/menu/costs',
          schema: menuCostsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * Stores the item's photo. `photo` must already be re-encoded (`platform/photo.ts`): the server
     * does not strip location data. The type sent is the blob's own, not a guess.
     */
    putPhoto: async (id: string, photo: Blob) =>
      (
        await put({
          path: `/v1/menu/items/${menuId(id)}/photo`,
          rawBody: { data: photo, contentType: photo.type },
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    removePhoto: async (id: string) =>
      (
        await del({
          path: `/v1/menu/items/${menuId(id)}/photo`,
          schema: itemDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
  };

  /** A create that is safe to repeat: 201 for a new row, 200 for the row an earlier try made. */
  async function create<S extends z.ZodType>(
    path: string,
    inputSchema: Schema<unknown>,
    schema: S,
    input: object,
    options?: { clientRequestId?: string },
  ) {
    const clientRequestId = options?.clientRequestId ?? newClientRequestId();
    const { data, status } = await post<z.output<S>>({
      path,
      body: checked(inputSchema, { ...input, clientRequestId }),
      schema,
      session: true,
      device: 'optional',
      headers: { 'Idempotency-Key': clientRequestId },
    });
    return { row: data, replay: status === 200, clientRequestId };
  }

  const sync = {
    /** One page of changes newer than `since`, the same frames the socket pushes. */
    changes: async (query: z.input<typeof syncQuerySchema>) => {
      const parsed = checked(syncQuerySchema, query);
      return (
        await get({
          path: '/v1/sync',
          query: { since: String(parsed.since), limit: String(parsed.limit) },
          schema: syncResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
    },
  };

  const recipients = {
    /**
     * Remembered recipients, most recent first, for the order screen. `q` is the name staff typed
     * (personal data): it travels in the query only, and no error or log line ever repeats it.
     */
    list: async (query: z.input<typeof recipientsQuerySchema> = {}) => {
      const parsed = checked(recipientsQuerySchema, query);
      return (
        await get({
          path: '/v1/recipients',
          query: {
            ...(parsed.q ? { q: parsed.q } : {}),
            ...(parsed.building ? { building: parsed.building } : {}),
            limit: String(parsed.limit),
          },
          schema: recipientsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
    },
  };

  /**
   * One settings resource: `read` is GET (never-saved settings answer the default at version 0),
   * `save` is PATCH, or PUT where the whole value is replaced. The body is checked against the
   * shared input schema first, so a body with no change or an unknown field never reaches the
   * network. Every save names the version it was built on (`expectedVersion`).
   */
  function settingsResource<V extends z.ZodType, I extends z.ZodType>(
    name: string,
    value: V,
    input: I,
    verb: 'patch' | 'put' = 'patch',
  ) {
    const path = `/v1/settings/${name}`;
    const schema = settingResponseSchema(value);
    return {
      read: async () => (await get({ path, schema, session: true, device: 'optional' })).data,
      save: async (body: z.input<I>) =>
        (
          await (verb === 'put' ? put : patch)({
            path,
            body: checked(input, body),
            schema,
            session: true,
            device: 'optional',
          })
        ).data,
    };
  }

  /**
   * The PromptPay ID as the settings screen sees it: masked, and nothing else. The server answers
   * (and echoes a change) with the ID in clear, so it is reduced here, before anything returns: no
   * screen, store or log can hold what this function never hands out. `save` is the one place a
   * full ID travels, from the person's own typing to the request.
   */
  const promptpayMasked = (() => {
    const path = '/v1/settings/promptpay';
    const schema = settingResponseSchema(promptpaySettingsSchema.nullable());
    const reduce = (answer: z.output<typeof schema>) => ({
      value:
        answer.value === null
          ? null
          : { idType: answer.value.idType, idMasked: maskPromptpayId(answer.value.idValue) },
      version: answer.version,
      rev: answer.rev,
      updatedAt: answer.updatedAt,
    });
    return {
      read: async () =>
        reduce((await get({ path, schema, session: true, device: 'optional' })).data),
      save: async (body: z.input<typeof promptpayPatchInputSchema>) =>
        reduce(
          (
            await patch({
              path,
              body: checked(promptpayPatchInputSchema, body),
              schema,
              session: true,
              device: 'optional',
            })
          ).data,
        ),
    };
  })();

  const settings = {
    shop: settingsResource('shop', shopSettingsSchema, shopPatchInputSchema),
    openingHours: settingsResource(
      'opening-hours',
      openingHoursSchema,
      openingHoursPatchInputSchema,
    ),
    numbering: settingsResource('numbering', businessDaySettingsSchema, numberingPatchInputSchema),
    payments: settingsResource('payments', paymentsSettingsSchema, paymentsPatchInputSchema),
    promptpayMasked,
    /** The ไทยช่วยไทย scheme (`scheme` null: none saved yet). Owner only, with a step-up. */
    govCopay: {
      read: async () =>
        (
          await get({
            path: '/v1/settings/gov-copay',
            schema: govCopayResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
      save: async (body: z.input<typeof govCopayPatchInputSchema>) =>
        (
          await patch({
            path: '/v1/settings/gov-copay',
            body: checked(govCopayPatchInputSchema, body),
            schema: govCopayResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
    },
    /** The buildings list as an editor reads and replaces it (PUT). */
    deliveryList: settingsResource(
      'delivery',
      deliverySettingsSchema,
      deliveryPatchInputSchema,
      'put',
    ),
    /** The buildings the shop delivers to (never-saved settings answer the default, version 0). */
    delivery: async () =>
      (
        await get({
          path: '/v1/settings/delivery',
          schema: settingResponseSchema(deliverySettingsSchema),
          session: true,
          device: 'optional',
        })
      ).data,
    /**
     * The shop's PromptPay ID IN CLEAR (roles with `settings.view`), for the offline QR (D-20).
     * Only the saved-ID store calls it. `value` is null when no ID was ever set. The answer is
     * a secret of the shop's account: never log it, never put it in an error or the page address.
     */
    promptpay: async () =>
      (
        await get({
          path: '/v1/settings/promptpay',
          schema: settingResponseSchema(promptpaySettingsSchema.nullable()),
          session: true,
          device: 'optional',
        })
      ).data,
  };

  const paymentPath = (id: string) => `/v1/payments/${checked(paymentIdParamSchema, { id }).id}`;

  /**
   * Payment calls never carry an amount: the server charges the order total. Cash sends only what
   * the customer handed over. A caller that may retry creates `clientRequestId` once and passes it
   * on every attempt (the server then answers the original, `replay: true`).
   */
  const payments = {
    create: async (
      orderId: string,
      input: NewPaymentInput,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `${orderPath(orderId)}/payments`,
        body: checked(createPaymentInputSchema, { ...input, clientRequestId }),
        schema: paymentResultSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { result: data, replay: status === 200, clientRequestId };
    },

    list: async (orderId: string) =>
      (
        await get({
          path: `${orderPath(orderId)}/payments`,
          schema: orderPaymentsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    claim: async (id: string, input: z.input<typeof claimPaymentInputSchema> = {}) =>
      paymentMove(`${paymentPath(id)}/claim`, checked(claimPaymentInputSchema, input)),

    confirm: async (id: string, input: z.input<typeof confirmPaymentInputSchema> = {}) =>
      paymentMove(`${paymentPath(id)}/confirm`, checked(confirmPaymentInputSchema, input)),

    cancelClaimed: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/cancel-claimed`, checked(paymentReasonInputSchema, input)),

    void: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/void`, checked(paymentReasonInputSchema, input)),

    refund: async (id: string, input: z.input<typeof paymentReasonInputSchema>) =>
      paymentMove(`${paymentPath(id)}/refund`, checked(paymentReasonInputSchema, input)),

    changeMethod: async (
      id: string,
      input: ChangePaymentInput,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `${paymentPath(id)}/change-method`,
        body: checked(changePaymentMethodInputSchema, { ...input, clientRequestId }),
        schema: changePaymentMethodResultSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { result: data, replay: status === 200, clientRequestId };
    },

    /**
     * A short-lived signed link for an `<img>` (it cannot send a header). The link is the only
     * authentication of the picture and is worth a few minutes: never log or store it. Ask again
     * whenever the QR is shown, and after a PromptPay settings change.
     */
    qrUrl: async (id: string) => {
      const link = (
        await get({
          path: `${paymentPath(id)}/qr-url`,
          schema: paymentQrUrlResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
      return { ...link, url: joinUrl(options.baseUrl, link.url) };
    },
  };

  async function paymentMove(path: string, body: unknown) {
    return (
      await post({
        path,
        body,
        schema: paymentResultSchema,
        session: true,
        device: 'optional',
      })
    ).data;
  }

  /**
   * Devices and staff (owner only). Every one of these routes asks for a fresh step-up, even the
   * lists, so callers go through `auth.runSensitive`. The staff routes take no idempotency key (the
   * API refuses extra fields): a lost answer to a create is settled by reading the list again, and
   * nothing here retries by itself. A PIN is only in the request body, never in a URL or an error.
   */
  const admin = {
    devices: async () =>
      (
        await get({
          path: '/v1/devices',
          schema: listDevicesResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    revokeDevice: async (id: string) =>
      (
        await post({
          path: `/v1/devices/${checked(idParamSchema, { id }).id}/revoke`,
          schema: deviceDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    staff: async () =>
      (
        await get({
          path: '/v1/staff',
          schema: listStaffResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    createStaff: async (input: z.input<typeof createStaffInputSchema>) =>
      (
        await post({
          path: '/v1/staff',
          body: checked(createStaffInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    patchStaff: async (id: string, input: z.input<typeof patchStaffInputSchema>) =>
      (
        await patch({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}`,
          body: checked(patchStaffInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /** A role change; a PIN of the new role only when it needs one (see `roleChangeNeedsPin`). */
    changeStaffRole: async (id: string, input: z.input<typeof changeRoleInputSchema>) =>
      (
        await post({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}/role`,
          body: checked(changeRoleInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    invites: async () =>
      (
        await get({
          path: '/v1/staff/invites',
          schema: listInvitesResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    /** The answer carries the invite token once: show the link, keep the token nowhere else. */
    createInvite: async (input: z.input<typeof createInviteInputSchema>) =>
      (
        await post({
          path: '/v1/staff/invites',
          body: checked(createInviteInputSchema, input),
          schema: createInviteResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,
    revokeInvite: async (id: string) => {
      await post<void>({
        path: `/v1/staff/invites/${checked(idParamSchema, { id }).id}/revoke`,
        session: true,
        device: 'optional',
      });
    },
    setStaffPin: async (id: string, input: z.input<typeof setStaffPinInputSchema>) =>
      (
        await post({
          path: `/v1/staff/${checked(idParamSchema, { id }).id}/pin`,
          body: checked(setStaffPinInputSchema, input),
          schema: staffDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,
  };

  const devices = {
    /**
     * The owner reports that they took over or cleared the entries another person left in this
     * device's offline outbox, so the server can audit it (counts only, never contents). Owner only,
     * fresh step-up (`auth.runSensitive`). A retry with the same `clientRequestId` answers 200 and
     * writes nothing more; the same id with other counts is 409 IDEMPOTENCY_KEY_REUSED.
     */
    outboxRecovery: async (
      deviceId: string,
      input: Omit<OutboxRecoveryInput, 'clientRequestId'>,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `/v1/devices/${checked(idParamSchema, { id: deviceId }).id}/outbox-recovery`,
        body: checked(outboxRecoveryInputSchema, { ...input, clientRequestId }),
        schema: outboxRecoveryResponseSchema,
        session: true,
        device: 'optional',
      });
      return { result: data, replay: status === 200, clientRequestId };
    },
  };

  return { auth, orders, menu, sync, payments, recipients, settings, admin, devices };
}

export type ApiClient = ReturnType<typeof createApiClient>;
