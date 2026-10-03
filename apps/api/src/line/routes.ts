import { lineRepo } from '@sds/db';
import {
  eventUserId,
  quotaMonth,
  routeEvent,
  verifySignature,
  webhookBodySchema,
  webhookEventSchema,
} from '@sds/line';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type GuardFactory, markLineSignatureCheck } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { handleEvent } from './handlers.ts';
import { buildSender, type LineRuntime, readPolicy } from './runtime.ts';

/** LINE's bodies are a few KB; anything bigger is not LINE. */
const WEBHOOK_BODY_LIMIT = 256 * 1024;

export const quotaResponseSchema = z.object({
  /** `YYYY-MM`, Asia/Bangkok. */
  month: z.string(),
  /** Pushes used this month (replies are free and not counted). */
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  policy: z.enum(['off', 'essential', 'all']),
  warnAtPercent: z.number().int(),
  /** False when the LINE_* secrets are not set on this server. */
  configured: z.boolean(),
});
export type QuotaResponse = z.infer<typeof quotaResponseSchema>;

/**
 * Mounted at /v1/line.
 * - `POST /webhook`: LINE's servers. No session; the `X-Line-Signature` HMAC over the raw body is
 *   the authentication. Answers 200 once every new event is stored (deduped by
 *   `webhookEventId`), then handles them after the reply, so a slow handler never makes LINE
 *   retry. A database failure before the answer is a 500, so LINE redelivers.
 * - `GET /quota` (`settings.view`): this month's push count against the limit.
 */
export async function registerLineRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  runtime: LineRuntime,
): Promise<void> {
  await app.register(async (webhook) => {
    // Only this scope reads JSON as raw bytes: the signature is over exactly what LINE sent.
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    const checkSignature = markLineSignatureCheck(
      async (request: FastifyRequest, _reply: FastifyReply) => {
        if (!runtime.channelSecret) {
          throw new ApiError(503, 'LINE_NOT_CONFIGURED', 'LINE is not configured on this server');
        }
        const header = request.headers['x-line-signature'];
        if (header === undefined) {
          throw new ApiError(401, 'LINE_SIGNATURE_MISSING', 'Missing signature');
        }
        const raw = request.body;
        if (!Buffer.isBuffer(raw) || !verifySignature(raw, header, runtime.channelSecret)) {
          throw new ApiError(403, 'LINE_SIGNATURE_INVALID', 'Invalid signature');
        }
      },
    );

    webhook.post(
      '/webhook',
      {
        preHandler: checkSignature,
        config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
        bodyLimit: WEBHOOK_BODY_LIMIT,
      },
      async (request, reply) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse((request.body as Buffer).toString('utf8'));
        } catch {
          throw new ApiError(400, 'BAD_REQUEST', 'Body is not JSON');
        }
        const envelope = webhookBodySchema.safeParse(parsedJson);
        if (!envelope.success) throw new ApiError(400, 'BAD_REQUEST', 'Unexpected body');

        // Store first. Only events that were never seen are handled; a redelivery is skipped.
        // All or nothing: if one insert fails the request is a 500 and nothing stays stored, so
        // LINE's redelivery is not mistaken for a duplicate and skipped.
        const fresh = await ctx.db.transaction(async (tx) => {
          const stored: ReturnType<typeof webhookEventSchema.parse>[] = [];
          for (const raw of envelope.data.events) {
            const event = webhookEventSchema.safeParse(raw);
            if (!event.success) continue; // not an event we can name or dedupe; LINE needs a 200
            const isNew = await lineRepo.insertEventIfNew(tx, {
              webhookEventId: event.data.webhookEventId,
              type: event.data.type,
              ...(eventUserId(event.data) ? { userId: eventUserId(event.data) as string } : {}),
              payload: raw,
            });
            if (isNew) stored.push(event.data);
          }
          return stored;
        });

        if (fresh.length > 0) {
          runtime.track(processEvents(ctx, runtime, fresh, request.log));
        }
        return reply.code(200).send({});
      },
    );
  });

  app.get('/quota', { onRequest: guard('settings.view') }, async (): Promise<QuotaResponse> => {
    const policy = await readPolicy(ctx.db);
    const month = quotaMonth(ctx.now());
    return quotaResponseSchema.parse({
      month,
      used: await lineRepo.getMonthUsage(ctx.db, month),
      limit: policy.monthlyLimit,
      policy: policy.push,
      warnAtPercent: policy.warnAtPercent,
      configured: runtime.channelSecret !== undefined && runtime.client !== null,
    });
  });
}

/** Runs after the 200. One failing event never stops the others; the row records only a class name. */
async function processEvents(
  ctx: AuthContext,
  runtime: LineRuntime,
  events: ReturnType<typeof webhookEventSchema.parse>[],
  log: FastifyRequest['log'],
): Promise<void> {
  const sender = buildSender({ db: ctx.db, runtime, events: ctx.events, now: ctx.now });
  for (const event of events) {
    let failure: string | undefined;
    try {
      await handleEvent(
        { db: ctx.db, sender, now: ctx.now, noticeUrl: runtime.noticeUrl },
        routeEvent(event),
      );
    } catch (error) {
      failure = error instanceof Error ? error.name : 'Error';
      // Class name only: an error message can carry a user id or text.
      log.warn({ lineEventType: event.type, errorName: failure }, 'LINE event handler failed');
    }
    await lineRepo
      .markEventProcessed(ctx.db, event.webhookEventId, ctx.now(), failure)
      .catch(() => undefined);
  }
}
