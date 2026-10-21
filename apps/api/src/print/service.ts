/**
 * The kitchen print queue (P8). One job per order when it reaches `preparing` (only while the
 * owner's printing switch is on), one more per staff reprint. The print program on the shop's
 * notebook PULLS: it claims a job (a 30 second lease), draws the ticket, sends it to the printer
 * and acks. A job becomes `printed` only through that ack.
 *
 * This is at-least-once. If the program prints and then dies before the ack arrives, the lease
 * runs out and the job is claimed again, so a ticket can come out twice. The print program keeps
 * the ids of what it printed and skips those, which is what makes it "no duplicate prints" in
 * practice.
 *
 * Every write is one transaction; the alert for a job that failed for good is published after the
 * commit. A ticket is built when the job is claimed and is never stored.
 */
import { insertAudit, ordersRepo, printRepo } from '@sds/db';
import {
  buildKitchenTicket,
  type ClaimPrintJobResponse,
  PRINT_LEASE_SECONDS,
  PRINT_MAX_ATTEMPTS,
  type PrintAckInput,
  type PrintJobDto,
  printRetryDelaySeconds,
  type ReprintOrderInput,
} from '@sds/shared';
import { type Principal, type RequestMeta, securityAlert } from '../auth/service.ts';
import { conflict, notFound } from '../errors.ts';
import { toOrderDto } from '../orders/dto.ts';
import { currentPrintingEnabled } from '../settings/service.ts';
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';

const toJobDto = (job: printRepo.PrintJobRow, orderNo: string): PrintJobDto => ({
  id: job.id,
  orderId: job.orderId,
  orderNo,
  kind: job.kind as PrintJobDto['kind'],
  seq: job.seq,
  status: job.status as PrintJobDto['status'],
  attempts: job.attempts,
  lastError: job.lastError as PrintJobDto['lastError'],
  createdAt: job.createdAt.toISOString(),
  printedAt: job.printedAt ? job.printedAt.toISOString() : null,
});

async function jobDto(db: CoreContext['db'], job: printRepo.PrintJobRow): Promise<PrintJobDto> {
  const order = await ordersRepo.findOrderById(db, job.orderId);
  return toJobDto(job, order?.orderNo ?? '');
}

/** Staff hear about a ticket that did not come out: ids and the order number, nothing else. */
async function alertFailed(
  ctx: CoreContext,
  tx: CoreContext['db'],
  emit: Emit,
  job: printRepo.PrintJobRow,
  deviceId: string | null,
) {
  const order = await ordersRepo.findOrderById(tx, job.orderId);
  emit(
    securityAlert(ctx, 'print.job_failed', 'warn', {
      deviceId,
      subject: { orderId: job.orderId },
      ...(order ? { orderNo: order.orderNo } : {}),
    }),
  );
}

// ---------- Enqueue ----------

/**
 * Creates the order's kitchen job, once. Does nothing while printing is off (the order is simply
 * skipped), and a second call for the same order changes nothing. Returns the job, or null.
 */
export async function enqueueKitchenJob(
  ctx: Pick<CoreContext, 'db' | 'now'>,
  orderId: string,
): Promise<printRepo.PrintJobRow | null> {
  if (!(await currentPrintingEnabled(ctx.db))) return null;
  return (
    (await printRepo.insertJob(ctx.db, {
      orderId,
      kind: 'kitchen',
      seq: 0,
      now: ctx.now(),
    })) ?? null
  );
}

// ---------- The print program ----------

/** Leases the oldest job that is due and builds its ticket, or answers `{ job: null }`. */
export async function claimPrintJob(
  ctx: CoreContext,
  deviceId: string,
): Promise<ClaimPrintJobResponse> {
  return withTransaction(ctx, async (tx, emit) => {
    const now = ctx.now();
    // A job that kept timing out is finished before anything new is handed out.
    for (const job of await printRepo.failExhausted(tx, { now, maxAttempts: PRINT_MAX_ATTEMPTS })) {
      await alertFailed(ctx, tx, emit, job, job.claimedByDeviceId);
    }
    const job = await printRepo.claimNext(tx, {
      deviceId,
      leaseToken: crypto.randomUUID(),
      now,
      leaseUntil: new Date(now.getTime() + PRINT_LEASE_SECONDS * 1000),
      maxAttempts: PRINT_MAX_ATTEMPTS,
    });
    if (!job?.leaseToken || !job.leaseUntil) return { job: null };

    const order = await ordersRepo.findOrderById(tx, job.orderId);
    if (!order) return { job: null }; // cannot happen: the foreign key holds the order
    const items = await ordersRepo.loadOrderItems(tx, [order.id]);
    const ticket = buildKitchenTicket(toOrderDto(order, items.get(order.id) ?? []), {
      reprint: job.kind === 'reprint',
      copy: job.seq,
    });
    return {
      job: {
        id: job.id,
        kind: job.kind as 'kitchen' | 'reprint',
        seq: job.seq,
        attempt: job.attempts,
        leaseToken: job.leaseToken,
        leaseUntil: job.leaseUntil.toISOString(),
        ticket,
      },
    };
  });
}

/**
 * The print program's answer. `printed` is idempotent and is accepted even when the lease has
 * since moved on (the paper is out either way). `failed` must carry the lease the job was claimed
 * with; it puts the job back with a delay, or fails it for good (and alerts) at the last attempt.
 */
export async function ackPrintJob(
  ctx: CoreContext,
  deviceId: string,
  jobId: string,
  input: PrintAckInput,
): Promise<PrintJobDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const job = await printRepo.lockById(tx, jobId);
    if (!job) throw notFound('Print job');
    if (job.status === 'printed') return jobDto(tx, job);
    const now = ctx.now();

    if (input.result === 'printed') {
      const done = await printRepo.markPrinted(tx, job.id, now);
      return jobDto(tx, done ?? job);
    }

    if (
      job.status !== 'claimed' ||
      job.leaseToken !== input.leaseToken ||
      job.claimedByDeviceId !== deviceId
    ) {
      throw conflict('LEASE_LOST', 'This job is no longer leased to the print program', {
        status: job.status,
      });
    }
    if (job.attempts >= PRINT_MAX_ATTEMPTS) {
      const failed = await printRepo.markFailed(tx, job.id, { now, errorCode: input.errorCode });
      await alertFailed(ctx, tx, emit, job, deviceId);
      return jobDto(tx, failed ?? job);
    }
    const retried = await printRepo.releaseForRetry(tx, job.id, {
      now,
      nextAttemptAt: new Date(now.getTime() + printRetryDelaySeconds(job.attempts) * 1000),
      errorCode: input.errorCode,
    });
    return jobDto(tx, retried ?? job);
  });
}

// ---------- Staff ----------

/**
 * Staff ask for another copy of an order's ticket. Each request makes exactly one new job: the
 * request id makes a retry return that job, and the order row lock gives each reprint its own
 * sequence number. Refused while printing is off (409 `PRINTING_OFF`): no job is made for a
 * print host that was switched off.
 */
export async function reprintOrder(
  ctx: CoreContext,
  actor: Principal,
  orderId: string,
  input: ReprintOrderInput,
  meta: RequestMeta,
): Promise<{ job: PrintJobDto; replay: boolean }> {
  const replayOf = async (db: CoreContext['db']) => {
    const existing = await printRepo.findByClientRequestId(db, input.clientRequestId);
    if (!existing) return null;
    if (existing.orderId !== orderId) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This request id was already used for another order. Make a new request id',
      );
    }
    return { job: await jobDto(db, existing), replay: true };
  };

  const early = await replayOf(ctx.db);
  if (early) return early;

  return withTransaction(ctx, async (tx) => {
    const order = await ordersRepo.lockOrderById(tx, orderId);
    if (!order) throw notFound('Order');
    // Two requests with one id meet here, one after the other, on the order's lock.
    const late = await replayOf(tx);
    if (late) return late;
    if (!(await currentPrintingEnabled(tx))) {
      throw conflict('PRINTING_OFF', 'Printing is switched off. Turn it on to print a ticket');
    }
    const job = await printRepo.insertJob(tx, {
      orderId,
      kind: 'reprint',
      seq: await printRepo.nextReprintSeq(tx, orderId),
      clientRequestId: input.clientRequestId,
      requestedByStaffId: actor.staffId,
      now: ctx.now(),
    });
    if (!job) throw conflict('PRINT_JOB_CONFLICT', 'Another reprint was made at the same time');
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'print.reprint',
      entity: 'print_jobs',
      entityId: job.id,
      after: { orderId, seq: job.seq },
      ip: meta.ip,
    });
    return { job: toJobDto(job, order.orderNo), replay: false };
  });
}

export async function listPrintJobs(ctx: CoreContext, limit: number): Promise<PrintJobDto[]> {
  const rows = await printRepo.listRecent(ctx.db, limit);
  return rows.map((row) => toJobDto(row.job, row.orderNo));
}
