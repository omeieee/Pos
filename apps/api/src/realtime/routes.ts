import websocket from '@fastify/websocket';
import { WS_MAX_CLIENT_MESSAGE_BYTES } from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type GuardFactory, markFirstMessageAuth, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { createHub, type Hub, type HubOptions, type WsLike } from './hub.ts';
import { createCatchUp } from './sync.ts';

export interface RealtimeOptions {
  hub?: Partial<HubOptions>;
  /** Upgrade requests per client address per minute, checked before the upgrade. */
  connectsPerMinute?: number;
}

/**
 * Call once on the ROOT instance, before the /v1 scope: registers the WebSocket plugin (so
 * `app.injectWS` exists for tests and the upgrade handler sees every route) and creates the hub.
 * The hub closes every socket with 1001 before the server stops listening; the plugin's own
 * pre-close would close them without a code and ahead of us, so it is replaced here.
 */
export async function setupRealtime(
  app: FastifyInstance,
  ctx: AuthContext,
  options: RealtimeOptions = {},
): Promise<{ hub: Hub; connectsPerMinute: number }> {
  const hub = createHub(ctx, options.hub ?? {}, app.log);
  await app.register(websocket, {
    options: { maxPayload: WS_MAX_CLIENT_MESSAGE_BYTES },
    preClose(done) {
      hub.shutdown().then(
        () => {
          this.websocketServer.close();
          done();
        },
        (error) => {
          app.log.error({ err: error }, 'websocket shutdown failed');
          done();
        },
      );
    },
  });
  // The plugin upgrades a request for ANY route it covers, then closes it ("no handler") and logs
  // the URL at info level. A signed QR link (`?exp=&sig=`, a 5-minute credential) must never reach
  // a log, so every upgrade except the one to /v1/ws is refused before anything else runs. This
  // hook runs ahead of each route's own hooks, and after routing, so the route's log level holds.
  app.addHook('onRequest', async (request, reply) => {
    if (request.ws && request.routeOptions.url !== '/v1/ws') {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Route not found', details: {} });
    }
  });
  return { hub, connectsPerMinute: options.connectsPerMinute ?? 60 };
}

/**
 * Mounted under /v1: `GET /v1/sync` (a session, like every other route) and `WS /v1/ws`. The
 * socket route has no guard: a browser WebSocket cannot send headers, so the hub authenticates the
 * FIRST message instead (see hub.ts), and the start-up check lets this route through only because
 * its handler is marked for that (`markFirstMessageAuth`).
 */
export async function registerRealtimeRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  realtime: { hub: Hub; connectsPerMinute: number },
): Promise<void> {
  const { hub } = realtime;
  const catchUp = createCatchUp(ctx);

  app.get(
    '/sync',
    {
      onRequest: guard(),
      // A catch-up is a few queries: generous for six devices behind one address, not unlimited.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return catchUp(principalOf(request), request.query, request.log);
    },
  );

  if (typeof app.rateLimit !== 'function') {
    throw new Error('the realtime routes need @fastify/rate-limit to be registered first');
  }
  const connectLimit = app.rateLimit({
    max: realtime.connectsPerMinute,
    timeWindow: '1 minute',
  });

  app.route({
    method: 'GET',
    url: '/ws',
    // No HEAD twin: the start-up check would have to know it too.
    exposeHeadRoute: false,
    onRequest: [connectLimit],
    // What the plugin calls with the upgraded socket. Marked, so the start-up check knows this
    // route authenticates its sockets itself (first message) instead of through a guard.
    wsHandler: markFirstMessageAuth((socket: unknown, request: { ip: string }) => {
      hub.accept(socket as WsLike, request.ip);
    }),
    // A plain HTTP request to the socket address.
    handler: async (_request, reply) =>
      reply.status(426).send({
        code: 'UPGRADE_REQUIRED',
        message: 'This address speaks WebSocket',
        details: {},
      }),
  });
}
