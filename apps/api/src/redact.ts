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

/** The parts of a Sentry event that can carry an error message (structural: no SDK import). */
type SentryEventLike = {
  message?: string | undefined;
  exception?: { values?: { value?: string | undefined }[] | undefined } | undefined;
};

/** Sentry `beforeSend`. `linkedErrors` adds each `cause` as another exception value. */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (typeof event.message === 'string') event.message = redactQueryParams(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = redactQueryParams(ex.value);
  }
  return event;
}

/** Options for `Sentry.init`. PII stays off explicitly, so a default change cannot turn it on. */
export function sentryOptions(o: { dsn: string; environment: string; release: string }) {
  return { ...o, sendDefaultPii: false, beforeSend: scrubSentryEvent };
}
