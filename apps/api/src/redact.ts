/**
 * Keeps personal data out of logs and Sentry. Drizzle puts the bound parameters of a failed
 * query into the error message ("Failed query: <sql>\nparams: <values>"), and those values are
 * customer data (phone, room, notes). Nothing built on that message may leave the process.
 */

/** Everything after the "params:" line of a Drizzle "Failed query" message. The SQL text stays. */
export function redactQueryParams(text: string): string {
  const start = text.indexOf('Failed query:');
  if (start < 0) return text;
  // First "params:" line, so a value that itself contains "params:" cannot leave a tail.
  const cut = text.indexOf('\nparams:', start);
  return cut < 0 ? text : `${text.slice(0, cut)}\nparams: [redacted]`;
}

/**
 * Names of fields that carry credentials: the PIN and password a client posts, the codes, the
 * tokens we hand out, and the headers they travel in.
 */
const CREDENTIAL_KEYS = [
  'password',
  'pin',
  'totp',
  'recoverycode',
  'sessiontoken',
  'devicetoken',
  'authorization',
  'x-device-token',
  'cookie',
  'idvalue',
];
const CREDENTIAL_FIELDS = [
  'password',
  'pin',
  'totp',
  'recoveryCode',
  'sessionToken',
  'deviceToken',
  'authorization',
  'x-device-token',
  'cookie',
  'idValue',
];

/**
 * Pino `redact` paths. A handler that logs a body or a headers object by mistake still prints
 * `[redacted]`: each field is covered at the top level and up to three levels down (req.headers,
 * res.body.nested ...). Fastify does not log bodies or headers by default; this is the safety net.
 */
export const LOG_REDACT_PATHS: string[] = CREDENTIAL_FIELDS.flatMap((field) => {
  const key = field.includes('-') ? `["${field}"]` : `.${field}`;
  const root = field.includes('-') ? `["${field}"]` : field;
  return [root, `*${key}`, `*.*${key}`, `*.*.*${key}`];
});

export type SerializedErr = {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
};

type ErrorLike = {
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  statusCode?: unknown;
  cause?: unknown;
};

const MAX_CAUSE_DEPTH = 3;

function scrubStack(stack: string, rawMessage: string, message: string): string {
  const replaced = rawMessage ? stack.split(rawMessage).join(message) : stack;
  // The header no longer matches the message: drop the frames rather than risk the params.
  return replaced.includes('\nparams: [redacted]') ? replaced : redactQueryParams(replaced);
}

function serialize(err: unknown, depth: number): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as ErrorLike;
  const rawMessage = typeof e.message === 'string' ? e.message : '';
  const message = redactQueryParams(rawMessage);
  const out: SerializedErr = {
    type: err.constructor?.name ?? 'Error',
    message,
    stack: typeof e.stack === 'string' ? scrubStack(e.stack, rawMessage, message) : '',
  };
  // An allow-list, not a copy: Drizzle puts `params` on the error, and Postgres puts the
  // offending value in `detail` ("Key (phone)=(...) already exists").
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code;
  if (typeof e.statusCode === 'number') out.statusCode = e.statusCode;
  if (e.cause !== undefined && depth < MAX_CAUSE_DEPTH) out.cause = serialize(e.cause, depth + 1);
  return out;
}

/** Pino `err` serializer: replaces the default, which copies every own property of the error. */
export function serializeErr<T>(err: T): T extends object ? SerializedErr : T {
  return serialize(err, 0) as T extends object ? SerializedErr : T;
}

/**
 * Pino `logMethod` hook. The `err` serializer only cleans the `err` field, but pino also
 * writes `msg`: given an error and no message it copies `err.message` into `msg`, and a caller
 * can pass `err.message` as the message. Both must be scrubbed too.
 */
export function scrubLogArgs(args: unknown[]): unknown[] {
  const out = args.map((a) => (typeof a === 'string' ? redactQueryParams(a) : a));
  const [first, second] = out;
  if (second === undefined && typeof first === 'object' && first !== null) {
    const holder = first as { err?: unknown; msg?: unknown };
    const err = first instanceof Error ? first : holder.msg === undefined ? holder.err : undefined;
    const message = (err as ErrorLike | null | undefined)?.message;
    if (typeof message === 'string') out[1] = redactQueryParams(message);
  }
  return out;
}

/** The parts of a Sentry event that can carry an error message or a request (structural: no SDK import). */
type SentryEventLike = {
  message?: string | undefined;
  exception?: { values?: { value?: string | undefined }[] | undefined } | undefined;
  request?:
    | {
        url?: string | undefined;
        /** A string, an object or a list of pairs, depending on the SDK. */
        query_string?: unknown;
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string> | undefined;
      }
    | undefined;
  breadcrumbs?:
    | { message?: string | undefined; data?: Record<string, unknown> | undefined }[]
    | undefined;
};

/** A URL without its query string and fragment: the signed QR link keeps its credential there. */
function withoutQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/** The `sig` parameter of a signed link, wherever it shows up inside free text. */
function withoutSig(text: string): string {
  return text.replace(/([?&])sig=[^&\s"'#]*/g, '$1sig=[redacted]');
}

/**
 * Sentry `beforeSend`. `linkedErrors` adds each `cause` as another exception value. The request
 * body (PINs, passwords), cookies and query string are dropped, the URL loses its query, and
 * credential headers are hidden, whatever the SDK attached.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (typeof event.message === 'string') {
    event.message = withoutSig(redactQueryParams(event.message));
  }
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = withoutSig(redactQueryParams(ex.value));
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = withoutSig(crumb.message);
    const url = crumb.data?.url;
    if (crumb.data && typeof url === 'string') crumb.data.url = withoutQuery(url);
    // Sentry's HTTP integrations put the query string under this key, apart from the URL.
    if (crumb.data) delete crumb.data['http.query'];
  }
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    // The 5-minute QR link credential (`sig`) sits in the query string of a 5xx on qr.png.
    delete request.query_string;
    if (typeof request.url === 'string') request.url = withoutQuery(request.url);
    for (const name of Object.keys(request.headers ?? {})) {
      if (CREDENTIAL_KEYS.includes(name.toLowerCase())) delete request.headers?.[name];
    }
  }
  return event;
}

/** Options for `Sentry.init`. PII stays off explicitly, so a default change cannot turn it on. */
export function sentryOptions(o: { dsn: string; environment: string; release: string }) {
  return { ...o, sendDefaultPii: false, beforeSend: scrubSentryEvent };
}
