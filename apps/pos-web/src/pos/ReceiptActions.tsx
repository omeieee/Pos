import { receiptFileName, receiptHtml } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { useRef, useState } from 'react';
import { newClientRequestId } from '../api/client.ts';
import { errorText } from '../api/errors.ts';
import { s } from '../design/style.ts';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { canIssueReceipt, receiptFromResponse } from './receipt-model.ts';

type Issued = ReturnType<typeof receiptFromResponse>;

/**
 * "ออกใบเสร็จ" for a confirmed payment. Pressing it asks the server to issue the receipt (an
 * audited action) and the page is built from the answer alone: the shop's tax ID and address come
 * from the server, never from this device. A press that failed is retried with the same request
 * id (the server then answers the same issue); a new press after success is not needed, so the
 * save and print buttons stay on the receipt already issued.
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
  const { api, files } = useServices();
  const [receipt, setReceipt] = useState<Issued | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  if (!canIssueReceipt(order, received)) return null;

  async function issue() {
    if (issuing) return;
    setIssuing(true);
    setFailure(null);
    requestId.current ??= newClientRequestId();
    try {
      const answer = await api.orders.receipt(order.id, { clientRequestId: requestId.current });
      requestId.current = null;
      setReceipt(receiptFromResponse(answer.receipt));
    } catch (error) {
      setFailure(errorText(tr, error, 'payment'));
    } finally {
      setIssuing(false);
    }
  }

  const html = (r: Issued) => receiptHtml(r, locale);
  return (
    <div style={s('display:flex;gap:8px;flex-wrap:wrap;justify-content:center')}>
      {receipt ? (
        <>
          <button
            type="button"
            className="g-btn"
            onClick={() => files.save(receiptFileName(receipt), 'text/html', html(receipt))}
          >
            {tr('payment.receipt.save')}
          </button>
          <button type="button" className="g-btn" onClick={() => files.print(html(receipt))}>
            {tr('payment.receipt.print')}
          </button>
        </>
      ) : (
        <button type="button" className="g-btn" disabled={issuing} onClick={() => void issue()}>
          {issuing ? tr('payment.receipt.issuing') : tr('payment.receipt.issue')}
        </button>
      )}
      {failure ? (
        <Callout tone="bad" role="alert">
          {failure}
        </Callout>
      ) : null}
    </div>
  );
}
