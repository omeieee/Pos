import { describe, expect, test } from 'vitest';
import { ORDER_STATUSES, type OrderStatus, PAYMENT_STATUSES, type PaymentStatus } from './enums.ts';
import { satang } from './money.ts';
import { initialOrderStatus, orderMachine } from './order-machine.ts';
import { derivePaymentStatus, paymentMachine } from './payment-machine.ts';
import type { Actor, TransitionContext, TransitionResult } from './state-machine.ts';

const ACTORS: Record<string, Actor> = {
  owner: { kind: 'staff', role: 'owner' },
  manager: { kind: 'staff', role: 'manager' },
  cashier: { kind: 'staff', role: 'cashier' },
  kitchen: { kind: 'staff', role: 'kitchen' },
  customer: { kind: 'customer' },
  system: { kind: 'system' },
};
type ActorName = keyof typeof ACTORS;

interface Expected {
  actors: ActorName[];
  reason?: true;
  stepUp?: true;
}

/**
 * Explicit expectations, written independently of the machine definitions.
 * Any pair missing here must be rejected as invalid_transition.
 */
const ORDER_EXPECTED: Partial<Record<`${OrderStatus}>${OrderStatus}`, Expected>> = {
  'new>preparing': { actors: ['owner', 'manager', 'cashier', 'kitchen'] },
  'new>cancelled': { actors: ['owner', 'manager', 'cashier', 'customer', 'system'], reason: true },
  'preparing>ready': { actors: ['owner', 'manager', 'cashier', 'kitchen'] },
  'ready>completed': { actors: ['owner', 'manager', 'cashier', 'kitchen'] },
  'preparing>cancelled': { actors: ['owner', 'manager'], reason: true },
  'ready>cancelled': { actors: ['owner', 'manager'], reason: true },
  'completed>cancelled': { actors: ['owner'], reason: true, stepUp: true },
};

const PAYMENT_EXPECTED: Partial<Record<`${PaymentStatus}>${PaymentStatus}`, Expected>> = {
  'pending>claimed': { actors: ['owner', 'manager', 'cashier', 'customer'] },
  'pending>confirmed': { actors: ['owner', 'manager', 'cashier'] },
  'claimed>confirmed': { actors: ['owner', 'manager', 'cashier'] },
  'pending>cancelled': { actors: ['owner', 'manager', 'cashier', 'customer', 'system'] },
  'claimed>cancelled': { actors: ['owner', 'manager', 'cashier'], reason: true },
  'confirmed>voided': { actors: ['owner', 'manager'], reason: true, stepUp: true },
  'confirmed>refunded': { actors: ['owner', 'manager'], reason: true, stepUp: true },
};

function gridCases<S extends string>(
  states: readonly S[],
  expected: Partial<Record<`${S}>${S}`, Expected>>,
) {
  const cases: [S, S, ActorName, Expected | undefined][] = [];
  for (const from of states)
    for (const to of states)
      for (const actor of Object.keys(ACTORS))
        cases.push([from, to, actor, expected[`${from}>${to}` as `${S}>${S}`]]);
  return cases;
}

function checkGrid<S extends string>(
  machine: { transition: (from: S, to: S, ctx: TransitionContext) => TransitionResult },
  states: readonly S[],
  expected: Partial<Record<`${S}>${S}`, Expected>>,
) {
  test.each(gridCases(states, expected))('%s → %s by %s', (from, to, actorName, exp) => {
    const actor = ACTORS[actorName] as Actor;
    const withReason = machine.transition(from, to, { actor, reason: 'test' });
    const noReason = machine.transition(from, to, { actor });

    if (!exp) {
      expect(withReason).toEqual({ ok: false, error: 'invalid_transition' });
      return;
    }
    if (!exp.actors.includes(actorName)) {
      expect(withReason).toEqual({ ok: false, error: 'forbidden' });
      return;
    }
    expect(withReason).toEqual({ ok: true, stepUp: exp.stepUp === true });
    if (exp.reason) {
      expect(noReason).toEqual({ ok: false, error: 'reason_required' });
      expect(machine.transition(from, to, { actor, reason: '   ' })).toEqual({
        ok: false,
        error: 'reason_required',
      });
    } else {
      expect(noReason.ok).toBe(true);
    }
  });
}

describe('order machine: every state pair × every actor', () => {
  checkGrid(orderMachine, ORDER_STATUSES, ORDER_EXPECTED);

  test('the machine has exactly the expected transitions', () => {
    expect(orderMachine.rules.map((r) => `${r.from}>${r.to}`).sort()).toEqual(
      Object.keys(ORDER_EXPECTED).sort(),
    );
  });

  test('cancelled has no exits; a finished order can only be voided (owner)', () => {
    expect(orderMachine.targets('completed')).toEqual(['cancelled']);
    expect(orderMachine.targets('cancelled')).toEqual([]);
  });

  test.each([
    ['storefront', 'preparing'],
    ['phone', 'preparing'],
    ['line', 'new'],
    ['grab', 'new'],
    ['lineman', 'new'],
  ] as const)('initial status for %s is %s', (channel, status) => {
    expect(initialOrderStatus(channel)).toBe(status);
  });
});

describe('payment machine: every state pair × every actor', () => {
  checkGrid(paymentMachine, PAYMENT_STATUSES, PAYMENT_EXPECTED);

  test('the machine has exactly the expected transitions', () => {
    expect(paymentMachine.rules.map((r) => `${r.from}>${r.to}`).sort()).toEqual(
      Object.keys(PAYMENT_EXPECTED).sort(),
    );
  });

  test('rule 2: neither the customer nor the system can ever confirm a payment', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const actor of [ACTORS.customer, ACTORS.system] as Actor[]) {
        expect(paymentMachine.transition(from, 'confirmed', { actor, reason: 'x' }).ok).toBe(false);
      }
    }
  });
});

describe('derivePaymentStatus', () => {
  const total = satang(14500);
  const p = (status: PaymentStatus, amount: number) => ({ status, amount: satang(amount) });

  test.each([
    ['no payments', [], 'unpaid'],
    ['only pending', [p('pending', 14500)], 'unpaid'],
    ['cancelled only', [p('cancelled', 14500)], 'unpaid'],
    ['claimed', [p('claimed', 14500)], 'awaiting_confirmation'],
    ['partially confirmed', [p('confirmed', 10000)], 'partially_paid'],
    ['partial + claimed', [p('confirmed', 10000), p('claimed', 4500)], 'awaiting_confirmation'],
    ['exactly confirmed', [p('confirmed', 14500)], 'paid'],
    ['split confirmed', [p('confirmed', 10000), p('confirmed', 4500)], 'paid'],
    ['paid with a stale claim', [p('confirmed', 14500), p('claimed', 100)], 'paid'],
    ['all refunded', [p('refunded', 14500)], 'refunded'],
    ['voided only', [p('voided', 14500)], 'unpaid'],
    ['refunded then paid again', [p('refunded', 14500), p('confirmed', 14500)], 'paid'],
  ] as const)('%s → %s', (_label, payments, expected) => {
    expect(derivePaymentStatus(total, payments)).toBe(expected);
  });
});
