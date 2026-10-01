import type { z } from 'zod';

/**
 * An expected failure with an HTTP status. The app's error handler turns it into the
 * `{code, message, details}` body. `details` must never hold secrets or request values.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');

export const deviceUnregistered = () =>
  new ApiError(401, 'DEVICE_UNREGISTERED', 'This device is not registered');

/** A PIN session presented without the device token it was opened on (or with another one). */
export const deviceMismatch = () =>
  new ApiError(401, 'DEVICE_MISMATCH', 'This session belongs to another device');

/** Wrong PIN, password or code. One answer for every cause, so it does not reveal which part failed. */
export const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Those details are not correct');

export const accountLocked = (until: Date, now: Date) =>
  new ApiError(423, 'ACCOUNT_LOCKED', 'Too many wrong attempts. Try again later', {
    retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  });

/** The TOTP secret cannot be read (AUTH_SECRET_KEY lost or changed). Only shown after the password was right. */
export const secondFactorUnavailable = () =>
  new ApiError(
    503,
    'SECOND_FACTOR_UNAVAILABLE',
    'The authenticator code cannot be checked right now. Sign in with a recovery code',
  );

export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Your role may not do this');

export const stepUpRequired = () =>
  new ApiError(403, 'STEP_UP_REQUIRED', 'Confirm your identity again to do this');

export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new ApiError(409, code, message, details);

export const versionConflict = (currentVersion: number) =>
  conflict('VERSION_CONFLICT', 'This was changed on another device. Reload and try again', {
    currentVersion,
  });

/** Field paths and codes only: Zod messages and received values stay out of the response. */
export function validationError(error: z.ZodError): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', 'The request is not valid', {
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    })),
  });
}
