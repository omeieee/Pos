/**
 * The print routes of the dev shop (`VITE_MOCK_API=1`) and of tests, answering the way
 * apps/api/src/print/routes.ts does: `GET /v1/print/jobs` for any signed-in staff, and
 * `POST /v1/orders/:id/reprint` for `order.create` (cashier, manager, owner; not the kitchen),
 * one job per `clientRequestId` (a repeat answers 200 with the same job), 409 PRINTING_OFF while
 * the Printing setting is off, 404 for an order it does not know. Everything is made up and
 * nothing is persisted. No print notebook exists here: a new job stays `pending`.
 */
import {
  type OrderDto,
  orderIdParamSchema,
  type PrintJobDto,
  ROLE_PERMISSIONS,
  reprintOrderInputSchema,
} from '@sds/shared';
import type { MockAnswer, MockCaller } from './mock-payments.ts';

interface Deps {
  now: () => number;
  orders: ReadonlyMap<string, OrderDto>;
  /** Is the Printing setting on right now? */
  printingEnabled: () => boolean;
  newUuid: () => string;
}

const error = (status: number, code: string): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details: {} },
});

export function createMockPrint(deps: Deps) {
  const at = (minutesAgo: number) => new Date(deps.now() - minutesAgo * 60_000).toISOString();
  // Newest first. A few earlier jobs so the list is not empty on a fresh dev shop.
  const jobs: PrintJobDto[] = [
    {
      id: deps.newUuid(),
      orderId: deps.newUuid(),
      orderNo: 'L-003',
      kind: 'kitchen',
      seq: 0,
      status: 'failed',
      attempts: 5,
      lastError: 'OUT_OF_PAPER',
      createdAt: at(25),
      printedAt: null,
    },
    {
      id: deps.newUuid(),
      orderId: deps.newUuid(),
      orderNo: 'L-002',
      kind: 'kitchen',
      seq: 0,
      status: 'printed',
      attempts: 1,
      lastError: null,
      createdAt: at(40),
      printedAt: at(40),
    },
  ];
  const byRequest = new Map<string, PrintJobDto>();

  function handle(method: string, path: string, body: unknown, caller: MockCaller) {
    if (method === 'GET' && path === '/v1/print/jobs') {
      return { status: 200, body: { jobs } } satisfies MockAnswer;
    }
    const one = /^\/v1\/orders\/([^/]+)\/reprint$/.exec(path);
    if (method !== 'POST' || !one) return null;
    if (!ROLE_PERMISSIONS[caller.role].has('order.create')) return error(403, 'FORBIDDEN');
    const params = orderIdParamSchema.safeParse({ id: one[1] });
    const input = reprintOrderInputSchema.safeParse(body);
    if (!params.success || !input.success) return error(400, 'VALIDATION_ERROR');
    const earlier = byRequest.get(input.data.clientRequestId);
    if (earlier) return { status: 200, body: earlier } satisfies MockAnswer;
    const order = deps.orders.get(params.data.id);
    if (!order) return error(404, 'NOT_FOUND');
    if (!deps.printingEnabled()) return error(409, 'PRINTING_OFF');
    const seq = jobs.filter((j) => j.orderId === order.id && j.kind === 'reprint').length + 1;
    const job: PrintJobDto = {
      id: deps.newUuid(),
      orderId: order.id,
      orderNo: order.orderNo,
      kind: 'reprint',
      seq,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: new Date(deps.now()).toISOString(),
      printedAt: null,
    };
    jobs.unshift(job);
    byRequest.set(input.data.clientRequestId, job);
    return { status: 201, body: job } satisfies MockAnswer;
  }

  return { handle };
}
