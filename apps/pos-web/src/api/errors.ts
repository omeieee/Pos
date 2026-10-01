/**
 * API errors as the staff app sees them. The API answers `{code, message, details}` with a
 * stable `code` (apps/api/src/errors.ts, orders/service.ts). The `message` is English developer
 * text and is never shown: every code maps to an i18n key here, and anything unknown falls back
 * to a generic Thai message.
 *
 * `ApiClientError` keeps only what the UI needs (code, status, wait time, current version). It
 * never holds the response body, the request body or a token, so it is safe to log or show.
 */
import type { MessageKey, MessageParams } from '@sds/i18n';

/** Server error code -> message. Add a row whenever the API gains a code. */
export const API_ERROR_KEYS = {
  UNAUTHENTICATED: 'error.unauthenticated',
  DEVICE_UNREGISTERED: 'error.deviceUnregistered',
  DEVICE_MISMATCH: 'error.deviceMismatch',
  INVALID_CREDENTIALS: 'error.invalidCredentials',
  ACCOUNT_LOCKED: 'error.accountLocked',
  FORBIDDEN: 'error.forbidden',
  STEP_UP_REQUIRED: 'error.stepUpRequired',
  SECOND_FACTOR_UNAVAILABLE: 'error.secondFactorUnavailable',
  NOT_FOUND: 'error.notFound',
  VERSION_CONFLICT: 'error.versionConflict',
  INVALID_TRANSITION: 'error.invalidTransition',
  ORDER_INVALID: 'error.orderInvalid',
  ORDER_CLOSED: 'error.orderClosed',
  ROOM_REQUIRED: 'error.roomRequired',
  REASON_REQUIRED: 'error.reasonRequired',
  UNKNOWN_CUSTOMER: 'error.unknownCustomer',
  IDEMPOTENCY_KEY_MISMATCH: 'error.idempotencyKeyMismatch',
  IDEMPOTENCY_KEY_REUSED: 'error.idempotencyKeyReused',
  VALIDATION_ERROR: 'error.validation',
  RATE_LIMITED: 'error.rateLimited',
  DB_UNAVAILABLE: 'error.server',
  INTERNAL: 'error.server',
} as const satisfies Record<string, MessageKey>;

export type KnownApiCode = keyof typeof API_ERROR_KEYS;

/** Failures that never reached a usable API answer. */
export const CLIENT_ERROR_KEYS = {
  NETWORK: 'error.network',
  TIMEOUT: 'error.timeout',
  /** The server answered 2xx but the body did not match the shared schema. */
  RESPONSE_INVALID: 'error.badResponse',
  /** The input did not pass the shared request schema, so nothing was sent. */
  REQUEST_INVALID: 'error.validation',
} as const satisfies Record<string, MessageKey>;

export type ClientErrorCode = keyof typeof CLIENT_ERROR_KEYS;

export function isKnownApiCode(code: string): code is KnownApiCode {
  return Object.hasOwn(API_ERROR_KEYS, code);
}

export function isClientErrorCode(code: string): code is ClientErrorCode {
  return Object.hasOwn(CLIENT_ERROR_KEYS, code);
}

export class ApiClientError extends Error {
  /** The API's `code`, or one of the client codes above, or 'UNKNOWN'. */
  readonly code: string;
  readonly status: number | null;
  /** From a 423 lock (`retryAfterSeconds`) or a 429 (`retryAfterMs`), in whole seconds. */
  readonly retryAfterSeconds: number | null;
  /** From a 409 VERSION_CONFLICT. */
  readonly currentVersion: number | null;

  constructor(
    code: string,
    init: {
      status?: number | null;
      retryAfterSeconds?: number | null;
      currentVersion?: number | null;
    } = {},
  ) {
    // The message is the code only: nothing from the server or the request ends up in logs.
    super(code);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = init.status ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.currentVersion = init.currentVersion ?? null;
  }
}

export const isApiClientError = (value: unknown): value is ApiClientError =>
  value instanceof ApiClientError;

/** Codes that mean "this device or session is no longer valid", handled once by the auth store. */
export const AUTH_FAILURE_CODES = ['UNAUTHENTICATED', 'DEVICE_UNREGISTERED', 'DEVICE_MISMATCH'];

/** What to say when the API gave no usable `code` (a proxy error page, for example). */
export function codeFromStatus(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'UNKNOWN';
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Where an error is shown; the sign-in screens say less than the generic text does. */
export type ErrorContext = 'pin' | 'ownerSignIn' | 'stepUp';

/** "5 นาที" / "1 ชั่วโมง": whole minutes below an hour, whole hours above (rounded up). */
export function waitText(tr: Translate, seconds: number): string {
  if (seconds >= 3600) return tr('duration.hours', { count: Math.ceil(seconds / 3600) });
  return tr('duration.minutes', { count: Math.max(1, Math.ceil(seconds / 60)) });
}

/**
 * The message to show for any thrown value. Owner sign-in answers the same for a wrong detail,
 * a locked account and an unknown e-mail, so the screen gives no hint whether the account exists.
 */
export function errorText(tr: Translate, error: unknown, context?: ErrorContext): string {
  if (!isApiClientError(error)) return tr('common.error');
  const { code, retryAfterSeconds } = error;

  if (context === 'ownerSignIn' && (code === 'INVALID_CREDENTIALS' || code === 'ACCOUNT_LOCKED')) {
    return tr('auth.owner.failed');
  }
  if (code === 'INVALID_CREDENTIALS') {
    if (context === 'pin') return tr('auth.pin.wrong');
    if (context === 'stepUp') return tr('auth.stepUp.failed');
  }
  if (code === 'ACCOUNT_LOCKED' && retryAfterSeconds !== null) {
    const wait = waitText(tr, retryAfterSeconds);
    if (context === 'pin') return tr('auth.pin.lockedFor', { wait });
    if (context === 'stepUp') return tr('auth.stepUp.lockedFor', { wait });
    return tr('error.accountLockedFor', { wait });
  }
  if (isKnownApiCode(code)) return tr(API_ERROR_KEYS[code]);
  if (isClientErrorCode(code)) return tr(CLIENT_ERROR_KEYS[code]);
  return tr('common.error');
}
