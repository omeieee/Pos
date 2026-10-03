/**
 * The order-status and payment routes of the dev shop (`VITE_MOCK_API=1`) and of tests, in the
 * shapes apps/api answers, using the SAME shared rules the real server uses: the order and payment
 * state machines, `calculateCashChange`, `estimateGovCopaySplit`, `isCopayAvailable`,
 * `derivePaymentStatus`. It is reached through mock-shop.ts and mock-server.ts, which are only
 * reachable through `src/dev/enable.ts` (guarded by `import.meta.env.DEV`), so production builds
 * do not contain it. Everything here is made up and nothing is persisted.
 *
 * Differences from the real API, on purpose: the PromptPay ID is a made-up masked value, the QR
 * link is unsigned (the dev server serves a placeholder picture at it), and the dev ไทยช่วยไทย
 * scheme is open all day so the guided steps can be tried at any hour.
 */
import {
  CashPaymentError,
  calculateCashChange,
  cancelOrderInputSchema,
  changePaymentMethodInputSchema,
  claimPaymentInputSchema,
  confirmPaymentInputSchema,
  createPaymentInputSchema,
  derivePaymentStatus,
  estimateGovCopaySplit,
  type GovCopayDto,
  govCopayPatchInputSchema,
  govCopaySchemeSchema,
  isCopayAvailable,
  maskPromptpayId,
  type OrderDto,
  orderMachine,
  type PaymentDto,
  type PaymentStatus,
  type PromptpaySettings,
  paymentMachine,
  paymentReasonInputSchema,
  paymentsPatchInputSchema,
  paymentsSettingsSchema,
  promptpayPatchInputSchema,
  type RealtimeFrame,
  ROLE_PERMISSIONS,
  type StaffRole,
  satang,
  transitionOrderInputSchema,
} from '@sds/shared';

import {
  type Attribution,
  createAttribution,
  originalStaffGate,
  originalStaffKnown,
} from './mock-original-staff.ts';

export interface MockCaller {
  role: StaffRole;
  /** Has this session passed a step-up in the last five minutes? */
  stepUpFresh: boolean;
  /** Who is calling, for the trail of an order or cash they made. */
  staffId?: string;
  /** Is this a staff member the server knows (the owner naming someone, see mock-original-staff)? */
  staffKnown?: (id: string) => boolean;
}

export interface MockAnswer {
  status: number;
  body: unknown;
}

interface Deps {
  now: () => number;
  orders: Map<string, OrderDto>;
  nextRev: () => number;
  newUuid: () => string;
  publish: (frame: RealtimeFrame & { rev: number }) => void;
  /** Who made a row and who it was named for; shared with the orders (default: its own). */
  attribution?: Attribution;
}

const errorBody = (code: string, details: Record<string, unknown> = {}) => ({
  code,
  message: 'mock server error',
  details,
});
const fail = (status: number, code: string, details: Record<string, unknown> = {}): MockAnswer => ({
  status,
  body: errorBody(code, details),
});

/** The made-up PromptPay ID the dev shop pays to: a 0 and nine digits, never a real account. */
export const MOCK_PROMPTPAY_ID = '0800001234';
/** What the shop shows of it (last digits only, like the real API). */
export const MOCK_PROMPTPAY_MASKED = maskPromptpayId(MOCK_PROMPTPAY_ID);

export function createMockPayments(deps: Deps) {
  const attribution = deps.attribution ?? createAttribution();
  const payments = new Map<string, PaymentDto>();
  // The ID the dev shop pays to now, and the rev/version of its setting row (see `setPromptpayId`).
  let promptpayId = MOCK_PROMPTPAY_ID;
  let promptpayRev = 0;
  let promptpayVersion = 1;
  let promptpayType: PromptpaySettings['idType'] = 'phone';
  // The payment methods the shop offers, changed from the settings screen (version 1: it is in the feed).
  let methods = paymentsSettingsSchema.parse({});
  let methodsVersion = 1;
  let methodsRev = 0;
  const promptpayMasked = () => maskPromptpayId(promptpayId);
  const byRequest = new Map<string, { paymentId: string; requestKey: string }>();

  /** Open all day, so the guided steps can be tried at any hour in the dev shop. */
  const scheme = (): GovCopayDto => {
    const day = (offset: number) =>
      new Date(deps.now() + offset * 86_400_000).toISOString().slice(0, 10);
    return {
      id: deps.newUuid(),
      code: 'mock_copay',
      nameTh: 'ไทยช่วยไทย พลัส (ตัวอย่าง)',
      nameEn: 'Thai Chuay Thai Plus (sample)',
      settlementNote: null,
      version: 1,
      rev: 0,
      govShareBp: 6000,
      govDailyCapSatang: satang(20000),
      govTotalCapSatang: satang(100000),
      activeFrom: day(-1),
      activeTo: day(60),
      activeFromMinute: 0,
      activeToMinute: 1440,
      channels: ['storefront'],
      enabled: true,
    };
  };
  let copayScheme = scheme();
  const settingsFrames = (): RealtimeFrame[] => {
    const frames: RealtimeFrame[] = [];
    methodsRev = deps.nextRev();
    promptpayRev = deps.nextRev();
    for (const [id, data, rev] of [
      ['payment_methods', methods, methodsRev],
      ['promptpay', { idType: promptpayType, idMasked: promptpayMasked() }, promptpayRev],
    ] as const) {
      frames.push({ type: 'settings.updated', id, rev, version: 1, data } as RealtimeFrame);
    }
    const rev = deps.nextRev();
    frames.push({
      type: 'settings.updated',
      id: 'gov_copay',
      rev,
      version: 1,
      data: { ...copayScheme, rev },
    } as RealtimeFrame);
    return frames;
  };

  const actorOf = (caller: MockCaller) => ({ kind: 'staff', role: caller.role }) as const;
  const forOrder = (orderId: string) =>
    [...payments.values()].filter((p) => p.orderId === orderId).sort((a, b) => a.rev - b.rev);

  function publishPayment(next: PaymentDto): PaymentDto {
    const stored = { ...next, rev: deps.nextRev() };
    payments.set(stored.id, stored);
    deps.publish({ type: 'payment.upserted', id: stored.id, rev: stored.rev, data: stored });
    return stored;
  }

  /** Re-derives the order's payment status from its payments and publishes the order. */
  function settleOrder(order: OrderDto, extra: Partial<OrderDto> = {}): OrderDto {
    const status = derivePaymentStatus(
      order.totalSatang,
      forOrder(order.id).map((p) => ({ status: p.status, amount: p.amountSatang })),
    );
    const next: OrderDto = {
      ...order,
      ...extra,
      paymentStatus: status,
      version: order.version + 1,
      rev: deps.nextRev(),
    };
    deps.orders.set(next.id, next);
    deps.publish({ type: 'order.upserted', id: next.id, rev: next.rev, data: next });
    return next;
  }

  const open = (orderId: string) =>
    forOrder(orderId).find((p) => p.status === 'pending' || p.status === 'claimed');

  const fromMachineError = (error: string, from: string, to: string): MockAnswer =>
    error === 'forbidden'
      ? fail(403, 'FORBIDDEN')
      : error === 'reason_required'
        ? fail(422, 'REASON_REQUIRED')
        : fail(409, 'INVALID_TRANSITION', { from, to });

  // ---------- Orders: list, transition, cancel ----------

  function listOrders(): MockAnswer {
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    return { status: 200, body: { day, orders: [...deps.orders.values()] } };
  }

  function moveOrder(
    orderId: string,
    to: OrderDto['status'],
    reason: string | undefined,
    caller: MockCaller,
  ): MockAnswer {
    const order = deps.orders.get(orderId);
    if (!order) return fail(404, 'NOT_FOUND');
    const verdict = orderMachine.transition(order.status, to, { actor: actorOf(caller), reason });
    if (!verdict.ok) return fromMachineError(verdict.error, order.status, to);
    const at = new Date(deps.now()).toISOString();
    const stamps: Partial<OrderDto> =
      to === 'preparing'
        ? { acceptedAt: at }
        : to === 'ready'
          ? { readyAt: at }
          : to === 'completed'
            ? { completedAt: at }
            : { cancelledAt: at, cancelReason: reason ?? '' };
    if (to === 'cancelled') {
      const blocking = forOrder(orderId).find(
        (p) => p.status === 'claimed' || p.status === 'confirmed',
      );
      if (blocking)
        return fail(409, 'ORDER_HAS_PAYMENT', { paymentId: blocking.id, status: blocking.status });
      for (const p of forOrder(orderId)) {
        if (p.status === 'pending')
          publishPayment({ ...p, status: 'cancelled', version: p.version + 1 });
      }
    }
    return { status: 200, body: settleOrder({ ...order, status: to }, stamps) };
  }

  // ---------- Payments ----------

  function insertPayment(
    order: OrderDto,
    input: ReturnType<typeof createPaymentInputSchema.parse>,
    caller: MockCaller,
  ): MockAnswer | PaymentDto {
    if (order.status === 'cancelled') return fail(409, 'ORDER_CLOSED');
    if (order.totalSatang <= 0) return fail(422, 'NOTHING_TO_PAY');
    if (input.method !== 'gov_copay' && !methods[input.method]) return fail(422, 'METHOD_DISABLED');
    const existing = forOrder(order.id);
    if (existing.some((p) => p.status === 'confirmed')) return fail(409, 'ORDER_ALREADY_PAID');
    const waiting = open(order.id);
    if (waiting)
      return fail(409, 'PAYMENT_ALREADY_OPEN', { paymentId: waiting.id, status: waiting.status });

    const base: Omit<PaymentDto, 'status'> = {
      id: deps.newUuid(),
      orderId: order.id,
      method: input.method,
      amountSatang: order.totalSatang,
      tenderedSatang: null,
      changeSatang: null,
      promptpayTargetMasked: null,
      schemeId: null,
      estGovShareSatang: null,
      estCustomerShareSatang: null,
      referenceNote: input.referenceNote ?? null,
      claimedAt: null,
      confirmedByStaffId: null,
      confirmedAt: null,
      reason: null,
      version: 1,
      rev: 0,
    };
    const draft: PaymentDto = { ...base, status: 'pending' };

    if (input.method === 'cash') {
      const move = paymentMachine.transition('pending', 'confirmed', { actor: actorOf(caller) });
      if (!move.ok) return fromMachineError(move.error, 'pending', 'confirmed');
      let cash: ReturnType<typeof calculateCashChange>;
      try {
        cash = calculateCashChange(order.totalSatang, satang(input.tendered));
      } catch (error) {
        if (error instanceof CashPaymentError && error.code === 'tendered_below_total') {
          return fail(422, 'TENDERED_BELOW_TOTAL');
        }
        return fail(422, 'AMOUNT_TOO_LARGE');
      }
      return {
        ...draft,
        status: 'confirmed',
        tenderedSatang: cash.tendered,
        changeSatang: cash.change,
        confirmedAt: new Date(deps.now()).toISOString(),
      };
    }
    if (input.method === 'promptpay') {
      return { ...draft, promptpayTargetMasked: promptpayMasked() };
    }
    if (input.method === 'gov_copay') {
      if (
        order.channel === 'grab' ||
        order.channel === 'lineman' ||
        !isCopayAvailable(copayScheme, new Date(deps.now()), 'storefront', order.fulfillment)
      ) {
        return fail(422, 'GOV_COPAY_UNAVAILABLE');
      }
      const split = estimateGovCopaySplit(order.totalSatang, copayScheme);
      return {
        ...draft,
        schemeId: copayScheme.id,
        estGovShareSatang: split.govShare,
        estCustomerShareSatang: split.customerShare,
      };
    }
    return draft;
  }

  function create(orderId: string, body: unknown, caller: MockCaller): MockAnswer {
    const input = createPaymentInputSchema.safeParse(body);
    if (!input.success) return fail(400, 'VALIDATION_ERROR');
    const order = deps.orders.get(orderId);
    if (!order) return fail(404, 'NOT_FOUND');
    // Cash may name the person who took it (the owner, with a fresh step-up): checked before the
    // request id is looked at, like the server.
    const named = input.data.method === 'cash' ? input.data.originalStaffId : undefined;
    const gate = originalStaffGate(caller, named);
    if (gate) return gate;
    const requestKey = JSON.stringify([
      orderId,
      { ...input.data, clientRequestId: undefined, originalStaffId: undefined },
    ]);
    const known = byRequest.get(input.data.clientRequestId);
    if (known) {
      if (known.requestKey !== requestKey) return fail(409, 'IDEMPOTENCY_KEY_REUSED');
      const refused = attribution.replayRefusal(input.data.clientRequestId, named);
      if (refused) return refused;
      const payment = payments.get(known.paymentId);
      const current = deps.orders.get(orderId);
      return payment && current
        ? { status: 200, body: { payment, order: current } }
        : fail(404, 'NOT_FOUND');
    }
    const unknown = originalStaffKnown(caller, named);
    if (unknown) return unknown;
    const made = insertPayment(order, input.data, caller);
    if ('status' in made && 'body' in made) return made as MockAnswer;
    const payment = publishPayment(made as PaymentDto);
    byRequest.set(input.data.clientRequestId, { paymentId: payment.id, requestKey });
    attribution.remember(input.data.clientRequestId, named, caller.staffId);
    return { status: 201, body: { payment, order: settleOrder(order) } };
  }

  function move(
    paymentId: string,
    action: 'claim' | 'confirm' | 'cancel-claimed' | 'void' | 'refund',
    body: unknown,
    caller: MockCaller,
  ): MockAnswer {
    const payment = payments.get(paymentId);
    if (!payment) return fail(404, 'NOT_FOUND');
    const order = deps.orders.get(payment.orderId);
    if (!order) return fail(404, 'NOT_FOUND');
    const to: PaymentStatus = {
      claim: 'claimed',
      confirm: 'confirmed',
      'cancel-claimed': 'cancelled',
      void: 'voided',
      refund: 'refunded',
    }[action] as PaymentStatus;
    const schema =
      action === 'claim'
        ? claimPaymentInputSchema
        : action === 'confirm'
          ? confirmPaymentInputSchema
          : paymentReasonInputSchema;
    const input = schema.safeParse(body ?? {});
    if (!input.success)
      return action === 'cancel-claimed' || action === 'void' || action === 'refund'
        ? fail(422, 'REASON_REQUIRED')
        : fail(400, 'VALIDATION_ERROR');
    if (payment.status === to) return { status: 200, body: { payment, order } };
    if (action === 'cancel-claimed' && payment.status !== 'claimed') {
      return fail(409, 'INVALID_TRANSITION', { from: payment.status, to });
    }
    const data: Record<string, unknown> = { ...input.data };
    const reason = typeof data.reason === 'string' ? data.reason : undefined;
    const referenceNote = typeof data.referenceNote === 'string' ? data.referenceNote : undefined;
    const verdict = paymentMachine.transition(payment.status, to, {
      actor: actorOf(caller),
      reason,
    });
    if (!verdict.ok) return fromMachineError(verdict.error, payment.status, to);
    if (verdict.stepUp && !caller.stepUpFresh) return fail(403, 'STEP_UP_REQUIRED');
    const at = new Date(deps.now()).toISOString();
    const patch: Partial<PaymentDto> =
      to === 'claimed'
        ? { claimedAt: at }
        : to === 'confirmed'
          ? {
              confirmedAt: at,
              ...(referenceNote ? { referenceNote } : {}),
            }
          : { reason: reason ?? '' };
    const updated = publishPayment({
      ...payment,
      ...patch,
      status: to,
      version: payment.version + 1,
    });
    return { status: 200, body: { payment: updated, order: settleOrder(order) } };
  }

  function changeMethod(paymentId: string, body: unknown, caller: MockCaller): MockAnswer {
    const input = changePaymentMethodInputSchema.safeParse(body);
    if (!input.success) return fail(400, 'VALIDATION_ERROR');
    const source = payments.get(paymentId);
    if (!source) return fail(404, 'NOT_FOUND');
    const order = deps.orders.get(source.orderId);
    if (!order) return fail(404, 'NOT_FOUND');
    const requestKey = JSON.stringify([paymentId, { ...input.data, clientRequestId: undefined }]);
    const known = byRequest.get(input.data.clientRequestId);
    if (known) {
      const payment = payments.get(known.paymentId);
      const cancelledPayment = payments.get(paymentId);
      const current = deps.orders.get(order.id);
      return payment && cancelledPayment && current
        ? { status: 200, body: { payment, cancelledPayment, order: current } }
        : fail(404, 'NOT_FOUND');
    }
    if (source.status !== 'pending')
      return fail(409, 'PAYMENT_NOT_PENDING', { status: source.status });
    if (source.method === input.data.method) return fail(422, 'METHOD_UNCHANGED');
    // The old payment is cancelled first so the "one open payment" rule lets the new one in; if the
    // new one cannot be made, the old one is put back.
    const cancelled = { ...source, status: 'cancelled' as PaymentStatus };
    payments.set(source.id, cancelled);
    const { clientRequestId: _ignored, expectedVersion: _version, ...choice } = input.data;
    const made = insertPayment(
      order,
      { ...choice, clientRequestId: input.data.clientRequestId } as never,
      caller,
    );
    if ('status' in made && 'body' in made) {
      payments.set(source.id, source);
      return made as MockAnswer;
    }
    const cancelledPayment = publishPayment({ ...cancelled, version: source.version + 1 });
    const payment = publishPayment(made as PaymentDto);
    byRequest.set(input.data.clientRequestId, { paymentId: payment.id, requestKey });
    return { status: 201, body: { payment, cancelledPayment, order: settleOrder(order) } };
  }

  function qrUrl(paymentId: string): MockAnswer {
    const payment = payments.get(paymentId);
    if (!payment) return fail(404, 'NOT_FOUND');
    if (
      payment.method !== 'promptpay' ||
      (payment.status !== 'pending' && payment.status !== 'claimed')
    ) {
      return fail(409, 'QR_NOT_AVAILABLE');
    }
    const exp = Math.floor(deps.now() / 1000) + 300;
    return {
      status: 200,
      body: {
        url: `/v1/payments/${paymentId}/qr.png?exp=${exp}&sig=MOCKSIGNATUREMOCKSIGNATUREMOCKSIGNATUREMOCK`,
        expiresAt: new Date(exp * 1000).toISOString(),
        promptpayTargetMasked: promptpayMasked(),
      },
    };
  }

  /** `GET /v1/settings/promptpay`: the clear ID, for a role that may view settings (403 otherwise). */
  function readPromptpay(caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.view')) return fail(403, 'FORBIDDEN');
    return {
      status: 200,
      body: {
        value: { idType: promptpayType, idValue: promptpayId },
        version: promptpayVersion,
        rev: promptpayRev,
        updatedAt: new Date(deps.now()).toISOString(),
      },
    };
  }

  /**
   * Dev: the owner changes the PromptPay ID. The feed carries the masked notice with a newer rev,
   * exactly like the real server, and later payments pay to the new account.
   */
  function setPromptpayId(next: string) {
    promptpayId = next;
    promptpayVersion += 1;
    promptpayRev = deps.nextRev();
    deps.publish({
      type: 'settings.updated',
      id: 'promptpay',
      rev: promptpayRev,
      version: promptpayVersion,
      data: { idType: promptpayType, idMasked: promptpayMasked() },
    } as RealtimeFrame & { rev: number });
  }

  // ---------- Settings that live with the payments ----------

  const settingsError = (status: number, code: string, details: Record<string, unknown> = {}) =>
    fail(status, code, details);
  const conflict = (version: number) =>
    settingsError(409, 'VERSION_CONFLICT', { currentVersion: version });
  const stamp = () => new Date(deps.now()).toISOString();

  function readMethods(caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.view')) return fail(403, 'FORBIDDEN');
    return {
      status: 200,
      body: { value: methods, version: methodsVersion, rev: methodsRev, updatedAt: stamp() },
    };
  }

  /** `PATCH /v1/settings/payments`: settings.edit, no step-up. */
  function patchMethods(body: unknown, caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.edit')) return fail(403, 'FORBIDDEN');
    const input = paymentsPatchInputSchema.safeParse(body);
    if (!input.success) return fail(400, 'VALIDATION_ERROR');
    if (input.data.expectedVersion !== methodsVersion) return conflict(methodsVersion);
    const { expectedVersion: _version, ...given } = input.data;
    const next = paymentsSettingsSchema.parse({
      ...methods,
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
    });
    if (JSON.stringify(next) !== JSON.stringify(methods)) {
      methods = next;
      methodsVersion += 1;
      methodsRev = deps.nextRev();
      deps.publish({
        type: 'settings.updated',
        id: 'payment_methods',
        rev: methodsRev,
        version: methodsVersion,
        data: methods,
      } as RealtimeFrame & { rev: number });
    }
    return readMethods(caller);
  }

  /** `PATCH /v1/settings/promptpay`: the owner, with a fresh step-up. The answer carries the ID in clear, like the real one. */
  function patchPromptpay(body: unknown, caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.promptpay')) return fail(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return fail(403, 'STEP_UP_REQUIRED');
    const input = promptpayPatchInputSchema.safeParse(body);
    if (!input.success) return fail(400, 'VALIDATION_ERROR');
    if (input.data.expectedVersion !== promptpayVersion) return conflict(promptpayVersion);
    promptpayType = input.data.idType;
    setPromptpayId(input.data.idValue);
    return readPromptpay(caller);
  }

  const schemeRev = () => copayScheme.rev;
  const copayFrame = () =>
    ({
      type: 'settings.updated',
      id: 'gov_copay',
      rev: schemeRev(),
      version: copayScheme.version,
      data: copayScheme,
    }) as RealtimeFrame & { rev: number };

  function readCopay(caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.view')) return fail(403, 'FORBIDDEN');
    return { status: 200, body: { scheme: copayScheme } };
  }

  /** `PATCH /v1/settings/gov-copay`: the owner, with a fresh step-up; the whole scheme is checked again. */
  function patchCopay(body: unknown, caller: MockCaller): MockAnswer {
    if (!ROLE_PERMISSIONS[caller.role].has('settings.gov_copay')) return fail(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return fail(403, 'STEP_UP_REQUIRED');
    const input = govCopayPatchInputSchema.safeParse(body);
    if (!input.success) return fail(400, 'VALIDATION_ERROR');
    const { expectedVersion, code: _code, nameTh, nameEn, settlementNote, ...rest } = input.data;
    if (expectedVersion !== copayScheme.version) return conflict(copayScheme.version);
    const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const merged = govCopaySchemeSchema.safeParse({
      govShareBp: copayScheme.govShareBp,
      govDailyCapSatang: copayScheme.govDailyCapSatang,
      govTotalCapSatang: copayScheme.govTotalCapSatang,
      activeFrom: copayScheme.activeFrom,
      activeTo: copayScheme.activeTo,
      activeFromMinute: copayScheme.activeFromMinute,
      activeToMinute: copayScheme.activeToMinute,
      channels: copayScheme.channels,
      enabled: copayScheme.enabled,
      ...given,
    });
    if (!merged.success) return fail(400, 'VALIDATION_ERROR');
    if (merged.data.enabled && (merged.data.channels.length === 0 || merged.data.govShareBp <= 0)) {
      return fail(400, 'VALIDATION_ERROR');
    }
    const rev = deps.nextRev();
    copayScheme = {
      ...copayScheme,
      ...merged.data,
      ...(nameTh === undefined ? {} : { nameTh }),
      ...(nameEn === undefined ? {} : { nameEn }),
      ...(settlementNote === undefined ? {} : { settlementNote }),
      version: copayScheme.version + 1,
      rev,
    };
    deps.publish(copayFrame());
    return readCopay(caller);
  }

  /** Answers the order-status and payment routes (null: not one of them). */
  function handle(
    method: string,
    path: string,
    body: unknown,
    caller: MockCaller,
  ): MockAnswer | null {
    if (method === 'GET' && path === '/v1/orders') return listOrders();
    if (method === 'GET' && path === '/v1/settings/promptpay') return readPromptpay(caller);
    if (method === 'PATCH' && path === '/v1/settings/promptpay')
      return patchPromptpay(body, caller);
    if (method === 'GET' && path === '/v1/settings/payments') return readMethods(caller);
    if (method === 'PATCH' && path === '/v1/settings/payments') return patchMethods(body, caller);
    if (method === 'GET' && path === '/v1/settings/gov-copay') return readCopay(caller);
    if (method === 'PATCH' && path === '/v1/settings/gov-copay') return patchCopay(body, caller);
    const orderRoute = /^\/v1\/orders\/([^/]+)\/(transition|cancel|payments)$/.exec(path);
    if (orderRoute) {
      const [, id = '', what] = orderRoute;
      if (what === 'payments') {
        if (method === 'GET') return { status: 200, body: { payments: forOrder(id) } };
        if (method === 'POST') return create(id, body, caller);
      }
      if (method === 'POST' && what === 'transition') {
        const input = transitionOrderInputSchema.safeParse(body);
        return input.success
          ? moveOrder(id, input.data.to, input.data.reason, caller)
          : fail(400, 'VALIDATION_ERROR');
      }
      if (method === 'POST' && what === 'cancel') {
        const input = cancelOrderInputSchema.safeParse(body);
        return input.success
          ? moveOrder(id, 'cancelled', input.data.reason, caller)
          : fail(422, 'REASON_REQUIRED');
      }
    }
    const paymentRoute = /^\/v1\/payments\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (paymentRoute) {
      const [, id = '', what] = paymentRoute;
      if (method === 'GET' && what === 'qr-url') return qrUrl(id);
      if (method === 'POST') {
        if (what === 'change-method') return changeMethod(id, body, caller);
        if (
          what === 'claim' ||
          what === 'confirm' ||
          what === 'cancel-claimed' ||
          what === 'void' ||
          what === 'refund'
        ) {
          return move(id, what, body, caller);
        }
      }
    }
    return null;
  }

  return { handle, settingsFrames, setPromptpayId };
}
