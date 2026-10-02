import type { OrderDto, PaymentDto } from '@sds/shared';

/** The screen of a payment that is waiting (pending or claimed), by method. */
export function OpenPayment({
  order,
  payment,
}: {
  order: OrderDto;
  payment: PaymentDto | undefined;
}) {
  void order;
  void payment;
  return null;
}
