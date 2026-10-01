import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.ts';
import { ApiError } from './errors.ts';
import { LOG_REDACT_PATHS, scrubLogArgs, serializeErr } from './redact.ts';

export type AppOptions = {
  config: Pick<Config, 'corsOrigins' | 'version'>;
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>;
  /** How long /readyz waits for the database before answering 503. */
  readyTimeoutMs?: number;
  logger?: FastifyServerOptions['logger'];
  /** Runs right after the instance is created, before any route (e.g. Sentry's error hook). */
  setup?: (app: FastifyInstance) => void;
};

/** What reaches the error handler: Fastify errors, or plain objects thrown by plugins. */
type AppError = {
  statusCode?: number;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
};

/** Error body shape used by every route: `{code, message, details}`. */
function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { code, message, details };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Every logger the app builds gets the redacting `err` serializer; `false` stays off. */
function withErrRedaction(logger: AppOptions['logger'] = true): NonNullable<AppOptions['logger']> {
  if (logger === false) return false;
  const base = logger === true ? {} : logger;
  return {
    ...base,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    serializers: { ...base.serializers, err: serializeErr },
    hooks: {
      ...base.hooks,
      logMethod(args, method) {
        method.apply(this, scrubLogArgs(args) as typeof args);
      },
    },
  };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: withErrRedaction(options.logger),
    // Only private-network hops (Caddy on the Docker network) may set X-Forwarded-For,
    // so rate limits key on the real client IP and cannot be spoofed from outside.
    trustProxy: 'loopback, linklocal, uniquelocal',
  });
  options.setup?.(app);

  app.setErrorHandler<AppError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // An ApiError is an expected failure with a code the app chose (details carry no secrets), even
    // when it is a 5xx such as SECOND_FACTOR_UNAVAILABLE; anything else 5xx stays generic.
    if (status >= 500 && !(error instanceof ApiError)) {
      request.log.error({ err: error }, 'request failed');
      return reply.status(status).send(errorBody('INTERNAL', 'Internal server error'));
    }
    return reply
      .status(status)
      .send(errorBody(error.code ?? 'BAD_REQUEST', error.message, error.details ?? {}));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', 'Route not found')),
  );

  await app.register(cors, {
    origin: options.config.corsOrigins.length > 0 ? options.config.corsOrigins : false,
    // v11 defaults to GET, HEAD and POST only; PATCH (expectedVersion) must pass the preflight.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // Browsers may reuse a preflight answer for 10 minutes (Safari caps it lower on its own).
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      details: { retryAfterMs: context.ttl },
    }),
  });

  // Liveness: never touches the database, so a Supabase outage does not restart the container.
  app.get('/healthz', async () => ({ status: 'ok', version: options.config.version }));

  // Readiness: one round trip to the database. The uptime monitor calls it, which also
  // keeps the Supabase free project from pausing.
  const readyTimeoutMs = options.readyTimeoutMs ?? 3000;
  app.get(
    '/readyz',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        await withTimeout(options.checkDb(), readyTimeoutMs);
        return { status: 'ok' };
      } catch (error) {
        // Log the error class and code only: driver messages can carry host details.
        // Drizzle wraps driver errors; the driver's code is on `cause`.
        const e = error as { name?: string; code?: string; cause?: { code?: string } };
        request.log.warn(
          { dbError: { name: e.name, code: e.cause?.code ?? e.code } },
          'readiness check failed',
        );
        return reply.status(503).send(errorBody('DB_UNAVAILABLE', 'Database is not reachable'));
      }
    },
  );

  return app;
}
