// @vitest-environment jsdom

import type { OrderPaymentsResponse, StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { uuid } from '../test-support/frames.ts';
import { th } from '../test-support/payment-env.tsx';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { SlipView } from './SlipView.tsx';
import {
  canRecheckSlip,
  clearErrorKey,
  ownerSlipActions,
  recheckErrorKey,
  SLIP_CLEAR_REASON_MAX,
  slipAlertsOf,
  slipClearReasonProblem,
} from './slip-gate.ts';

// The staff-only slip notices (D-27): a blocked order, a flagged customer, the owner's review, and
// the owner's two clear buttons. None of it stops the manual confirm.

afterEach(cleanup);

const PAYMENT = uuid(500);
const ORDER = uuid(900);
const CUSTOMER = uuid(77);
const AT = '2030-10-15T04:00:00.000Z';

const answer = (over: Partial<OrderPaymentsResponse> = {}): OrderPaymentsResponse => ({
  payments: [],
  slipPaymentIds: [PAYMENT],
  slipChecks: [{ paymentId: PAYMENT, verify: { verdict: 'fraud', at: AT } }],
  ...over,
});
const blocked = answer({ slipBlocks: [{ paymentId: PAYMENT, at: AT, reason: 'fraud' }] });
const flagged = answer({ customerSlipFlag: { at: AT, reason: 'fraud', count: 2 } });
const reviewed = answer({
  slipChecks: [{ paymentId: PAYMENT, verify: { verdict: 'unchecked', reviewedAt: AT } }],
});

async function open(
  role: StaffRole,
  list: OrderPaymentsResponse,
  extra: Record<string, unknown> = {},
  freshStepUp = true,
) {
  const { auth } = await createTestAuth(role);
  if (role === 'owner' && freshStepUp) {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', code: '1' } as never });
  }
  const payments = { list: vi.fn(async () => list), ...extra };
  const env = createTestServices({ auth, payments });
  renderScreen(
    <SlipView
      orderId={ORDER}
      paymentId={PAYMENT}
      rev={1}
      amountSatang={7500}
      customerId={CUSTOMER}
    />,
    env.services,
  );
  return { env, payments };
}

const typeReason = (value: string) =>
  fireEvent.change(screen.getByLabelText(th['pos.slipBlock.reason.label']), {
    target: { value },
  });

describe('the banners', () => {
  test('a blocked order shows the red banner', async () => {
    await open('cashier', blocked);
    const banner = await screen.findByTestId('slip-block-banner');
    expect(banner.textContent).toBe(th['pos.slipBlock.banner']);
    expect(screen.queryByTestId('slip-flag-banner')).toBeNull();
  });

  test('a flagged customer shows the count', async () => {
    await open('cashier', flagged);
    const banner = await screen.findByTestId('slip-flag-banner');
    expect(banner.textContent).toContain('2');
    expect(screen.queryByTestId('slip-block-banner')).toBeNull();
  });

  test('both show together; neither shows with no block and no flag', async () => {
    await open('cashier', answer({ ...blocked, ...flagged }));
    await screen.findByTestId('slip-block-banner');
    expect(screen.getByTestId('slip-flag-banner')).toBeTruthy();
    cleanup();
    await open('cashier', answer({ slipChecks: [{ paymentId: PAYMENT }] }));
    await screen.findByTestId('slip-has');
    expect(screen.queryByTestId('slip-alerts')).toBeNull();
  });

  test('the banners also show when the claim came with no slip', async () => {
    await open('cashier', { ...blocked, slipPaymentIds: [] });
    await screen.findByTestId('slip-block-banner');
    expect(screen.getByTestId('slip-missing')).toBeTruthy();
  });

  test('a slip the owner reviewed says so and offers no re-check', async () => {
    await open('cashier', reviewed);
    const note = await screen.findByTestId('slip-reviewed');
    expect(note.textContent).toBe(th['pos.slipBlock.reviewed']);
    expect(screen.queryByTestId('slip-recheck')).toBeNull();
  });
});

describe('who sees the clear buttons', () => {
  test.each(['manager', 'cashier', 'kitchen'] as const)('%s sees none', async (role) => {
    await open(role, answer({ ...blocked, ...flagged }));
    await screen.findByTestId('slip-block-banner');
    expect(screen.queryByTestId('slip-block-clear')).toBeNull();
    expect(screen.queryByTestId('slip-flag-clear')).toBeNull();
  });

  test('the owner sees each only while there is something to clear', async () => {
    await open('owner', blocked);
    await screen.findByTestId('slip-block-clear');
    expect(screen.queryByTestId('slip-flag-clear')).toBeNull();
    cleanup();
    await open('owner', flagged);
    await screen.findByTestId('slip-flag-clear');
    expect(screen.queryByTestId('slip-block-clear')).toBeNull();
  });
});

describe('lifting the block', () => {
  test('needs a reason, runs the call, and reads the list again', async () => {
    const slipBlockClear = vi.fn(async () => answer());
    const { payments } = await open('owner', blocked, { slipBlockClear });
    fireEvent.click(await screen.findByTestId('slip-block-clear'));
    const submit = screen.getByTestId('slip-clear-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole('dialog').textContent).toContain(th['pos.slipBlock.reason.warn']);
    typeReason('  ตรวจในแอปธนาคารแล้ว  ');
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(slipBlockClear).toHaveBeenCalledTimes(1));
    const [id, input] = slipBlockClear.mock.calls[0] as unknown as [
      string,
      { reason: string; clientRequestId: string },
    ];
    expect(id).toBe(PAYMENT);
    expect(input.reason).toBe('ตรวจในแอปธนาคารแล้ว');
    expect(input.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(payments.list.mock.calls.length).toBeGreaterThan(1));
  });

  test('a reason over 200 characters cannot be sent', async () => {
    await open('owner', blocked, { slipBlockClear: vi.fn() });
    fireEvent.click(await screen.findByTestId('slip-block-clear'));
    typeReason('ก'.repeat(201));
    expect((screen.getByTestId('slip-clear-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('slip-clear-reason-error').textContent).toBe(
      th['pos.slipBlock.reason.tooLong'],
    );
  });

  test('without a fresh step-up the step-up dialog comes first and nothing is sent', async () => {
    const slipBlockClear = vi.fn(async () => answer());
    await open('owner', blocked, { slipBlockClear }, false);
    fireEvent.click(await screen.findByTestId('slip-block-clear'));
    typeReason('ตรวจแล้ว');
    fireEvent.click(screen.getByTestId('slip-clear-submit'));
    expect(await screen.findByText(th['auth.stepUp.title'])).toBeTruthy();
    expect(slipBlockClear).not.toHaveBeenCalled();
  });

  test('a refusal is said in Thai inside the dialog, which stays open', async () => {
    const slipBlockClear = vi.fn(async () => {
      throw new ApiClientError('SLIP_NOT_BLOCKED', { status: 409 });
    });
    await open('owner', blocked, { slipBlockClear });
    fireEvent.click(await screen.findByTestId('slip-block-clear'));
    typeReason('ตรวจแล้ว');
    fireEvent.click(screen.getByTestId('slip-clear-submit'));
    const error = await screen.findByTestId('slip-clear-error');
    expect(error.textContent).toBe(th['pos.slipBlock.err.notBlocked']);
    expect(error.textContent).not.toContain('SLIP_NOT_BLOCKED');
    expect(screen.getByTestId('slip-clear-submit')).toBeTruthy();
  });
});

describe('clearing the customer flag', () => {
  test('calls the flag endpoint with the order customer and refreshes', async () => {
    const slipFlagClear = vi.fn(async (_id: string, _input: unknown) => ({ slipFlag: null }));
    const { payments } = await open('owner', flagged, { slipFlagClear });
    fireEvent.click(await screen.findByTestId('slip-flag-clear'));
    typeReason('ลูกค้าติดต่อแล้ว');
    fireEvent.click(screen.getByTestId('slip-clear-submit'));
    await waitFor(() => expect(slipFlagClear).toHaveBeenCalledTimes(1));
    expect(slipFlagClear.mock.calls[0]?.[0]).toBe(CUSTOMER);
    await waitFor(() => expect(payments.list.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('pure helpers', () => {
  test('alerts come from the list answer', () => {
    expect(slipAlertsOf(blocked)).toEqual({ blocked: true, flagCount: null });
    expect(slipAlertsOf(flagged)).toEqual({ blocked: false, flagCount: 2 });
    expect(slipAlertsOf({ payments: [], slipBlocks: [] })).toEqual({
      blocked: false,
      flagCount: null,
    });
  });

  test('owner actions need the owner, something to clear and, for the flag, a customer', () => {
    const both = { blocked: true, flagCount: 1 };
    expect(ownerSlipActions(true, both, CUSTOMER)).toEqual({ clearBlock: true, clearFlag: true });
    expect(ownerSlipActions(false, both, CUSTOMER)).toEqual({
      clearBlock: false,
      clearFlag: false,
    });
    expect(ownerSlipActions(true, both, null).clearFlag).toBe(false);
    expect(ownerSlipActions(true, { blocked: false, flagCount: null }, CUSTOMER)).toEqual({
      clearBlock: false,
      clearFlag: false,
    });
  });

  test('reason: 1 to 200 characters after trimming', () => {
    expect(slipClearReasonProblem('')).toBe('empty');
    expect(slipClearReasonProblem('   ')).toBe('empty');
    expect(slipClearReasonProblem('ก')).toBeNull();
    expect(slipClearReasonProblem(`${'ก'.repeat(SLIP_CLEAR_REASON_MAX)}  `)).toBeNull();
    expect(slipClearReasonProblem('ก'.repeat(SLIP_CLEAR_REASON_MAX + 1))).toBe('tooLong');
  });

  test('re-check hides when reviewed or valid', () => {
    const f = { hasSlip: true, check: null, recipient: null, duplicate: false } as const;
    expect(canRecheckSlip('claimed', { ...f, verdict: 'unchecked' })).toBe(true);
    expect(canRecheckSlip('claimed', { ...f, verdict: 'unchecked', reviewed: true })).toBe(false);
    expect(canRecheckSlip('claimed', { ...f, verdict: 'valid' })).toBe(false);
  });

  test('new error codes map to their own messages', () => {
    expect(recheckErrorKey('SLIP_ALREADY_VALID')).toBe('pos.slipRecheck.err.alreadyValid');
    expect(recheckErrorKey('SLIP_REVIEWED')).toBe('pos.slipRecheck.err.reviewed');
    expect(clearErrorKey('SLIP_NOT_BLOCKED')).toBe('pos.slipBlock.err.notBlocked');
    expect(clearErrorKey('FORBIDDEN')).toBe('pos.slipBlock.err.forbidden');
    expect(clearErrorKey('NOT_FOUND')).toBe('pos.slipBlock.err.notFound');
    expect(clearErrorKey('NETWORK')).toBe('pos.slipBlock.err.failed');
    expect(clearErrorKey(undefined)).toBe('pos.slipBlock.err.failed');
  });
});
