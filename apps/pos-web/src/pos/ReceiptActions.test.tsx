// @vitest-environment jsdom
import { satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import {
  fixClock,
  loaded,
  ORDER,
  orderOf,
  paymentOf,
  setup,
  th,
} from '../test-support/payment-env.tsx';
import { renderScreen } from '../test-support/render.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';
import { canIssueReceipt, receiptFromResponse } from './receipt-model.ts';

beforeEach(fixClock);
afterEach(cleanup);

const confirmed = () =>
  paymentOf({ status: 'confirmed', tenderedSatang: satang(10000), changeSatang: satang(2500) });
const paid = () => orderOf({ paymentStatus: 'paid' }, 12);

const issued = (shop: { taxId: string | null; address: string | null }) => ({
  receipt: {
    issuedAt: '2030-10-15T05:01:00.000Z',
    shop: { nameTh: 'ร้านทดสอบ', nameEn: 'Test Shop', phone: null, ...shop },
    order: paid(),
    payment: confirmed(),
  },
  clientRequestId: 'ignored',
});

describe('receipt model', () => {
  test('only a paid, uncancelled order with a received payment can be issued', () => {
    expect(canIssueReceipt(paid(), confirmed())).toBe(true);
    expect(canIssueReceipt(paid(), undefined)).toBe(false);
    expect(canIssueReceipt(orderOf(), confirmed())).toBe(false);
    expect(canIssueReceipt({ ...paid(), status: 'cancelled' }, confirmed())).toBe(false);
  });

  test('the receipt comes from the response: its payment method and the shop lines', () => {
    const { receipt } = issued({ taxId: '1234567890121', address: '1 Test Rd' });
    const built = receiptFromResponse(receipt);
    expect(built.payment?.method).toBe('cash');
    expect(built.shop).toEqual({
      nameTh: 'ร้านทดสอบ',
      nameEn: 'Test Shop',
      taxId: '1234567890121',
      address: '1 Test Rd',
    });
  });
});

describe('issuing a receipt at the payment panel', () => {
  test('nothing is issued until pressed; then the server answer is saved and printed', async () => {
    const receipt = vi.fn(async () => issued({ taxId: '1234567890121', address: '1 Test Rd' }));
    const env = await setup({ order: paid(), payments: [confirmed()], orders: { receipt } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(receipt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.issue'] }));
    fireEvent.click(await screen.findByRole('button', { name: th['payment.receipt.save'] }));
    expect(receipt).toHaveBeenCalledTimes(1);
    const [name, mime, html] = env.files.save.mock.calls[0] as [string, string, string];
    expect(name).toMatch(/^receipt-.*\.html$/);
    expect(mime).toBe('text/html');
    expect(html).toContain('฿75.00');
    expect(html).toContain('ร้านทดสอบ');
    expect(html).toContain('1234567890121');
    expect(html).toContain('1 Test Rd');
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.print'] }));
    expect(env.files.print).toHaveBeenCalledWith(html);
  });

  test('a shop without tax data prints no tax or address line', async () => {
    const env = await setup({
      order: paid(),
      payments: [confirmed()],
      orders: { receipt: async () => issued({ taxId: null, address: null }) },
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.issue'] }));
    fireEvent.click(await screen.findByRole('button', { name: th['payment.receipt.save'] }));
    const html = (env.files.save.mock.calls[0] as [string, string, string])[2];
    expect(html).not.toContain('เลขประจำตัวผู้เสียภาษี');
  });

  test('a failed press retries with the same request id; 409 is said in Thai', async () => {
    const receipt = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('RECEIPT_NOT_AVAILABLE', { status: 409 }))
      .mockResolvedValueOnce(issued({ taxId: null, address: null }));
    const env = await setup({ order: paid(), payments: [confirmed()], orders: { receipt } });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.issue'] }));
    expect(await screen.findByText(th['error.receiptNotAvailable'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: th['payment.receipt.issue'] }));
    await waitFor(() => expect(receipt).toHaveBeenCalledTimes(2));
    const ids = receipt.mock.calls.map(
      (call) => (call[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(await screen.findByRole('button', { name: th['payment.receipt.save'] })).toBeTruthy();
  });

  test('is not offered before the payment is confirmed', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(screen.queryByRole('button', { name: th['payment.receipt.issue'] })).toBeNull();
  });
});
