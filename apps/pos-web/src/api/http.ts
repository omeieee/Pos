/** Typed API client: the HTTP transport the resources share (see client.ts). */
import { idParamSchema, orderIdParamSchema } from '@sds/shared';
import type { z } from 'zod';
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
  /** `'text'`: hand back the body as it is (a CSV file) instead of parsing JSON. */
  as?: 'text';
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
export function errorFromResponse(status: number, text: string): ApiClientError {
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
export function checked<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiClientError('REQUEST_INVALID');
  return result.data;
}

export function newClientRequestId(): string {
  return newUuid();
}

/** The HTTP core every resource shares: request building, timeout, auth-failure hook, parsing. */
export function createTransport(options: ApiClientOptions) {
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

    if (spec.as === 'text') return { data: text as T, status };
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

  return { options, doFetch, buildUrl, get, post, patch, put, del, menuId, orderPath, create };
}

export type Transport = ReturnType<typeof createTransport>;
