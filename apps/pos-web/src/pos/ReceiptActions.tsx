import { receiptFileName, receiptHtml } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { receiptFor } from './receipt-model.ts';

/**
 * "ออกใบเสร็จ" for a confirmed payment. Nothing is issued until staff press it: the first press
 * offers save or print, and the page itself is built on this device from the server's order.
 */
export function ReceiptActions({
  order,
  received,
}: {
  order: OrderDto;
  received: PaymentDto | undefined;
}) {
  const tr = useT();
  const locale = useLocale();
  const { files } = useServices();
  const [open, setOpen] = useState(false);
  const receipt = receiptFor(order, received);
  if (!receipt) return null;
  const html = () => receiptHtml(receipt, locale);
  return (
    <div style={s('display:flex;gap:8px;flex-wrap:wrap;justify-content:center')}>
      <button
        type="button"
        className="g-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {tr('payment.receipt.issue')}
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="g-btn"
            onClick={() => files.save(receiptFileName(receipt), 'text/html', html())}
          >
            {tr('payment.receipt.save')}
          </button>
          <button type="button" className="g-btn" onClick={() => files.print(html())}>
            {tr('payment.receipt.print')}
          </button>
        </>
      ) : null}
    </div>
  );
}
