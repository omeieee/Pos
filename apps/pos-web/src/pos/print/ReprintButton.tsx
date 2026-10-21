import { useEffect } from 'react';
import { errorText } from '../../api/errors.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useHasPermission, useServices, useStoreState, useT } from '../../ui/hooks.ts';
import { Callout } from '../../ui/Notice.tsx';

/**
 * "Reprint order": asks the server to queue the kitchen ticket again (cashier, manager, owner; the
 * kitchen role has no such button). The words come from the server's answer only: sent (with the
 * copy number), refused (`PRINTING_OFF` says printing is switched off in Settings), or not sent
 * because the device is offline. One tap sends one request; a second tap while it is on its way
 * does nothing (the button is disabled and the store refuses it too).
 */
export function ReprintButton({ orderId }: { orderId: string }) {
  const { print } = useServices();
  const flow = useStoreState(print);
  const tr = useT();
  const allowed = useHasPermission('order.create');
  // The outcome of an earlier visit to this order is not news any more.
  useEffect(() => print.dismiss(orderId), [print, orderId]);
  if (!allowed) return null;

  const pending = flow.pending.includes(orderId);
  const result = flow.results[orderId];

  return (
    <div style={s('display:flex;flex-direction:column;gap:10px;flex:none')}>
      <button
        type="button"
        className="g-btn"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void print.reprint(orderId)}
      >
        <Gi n="receipt2" />
        {pending ? tr('print.reprint.sending') : tr('print.reprint.button')}
      </button>
      {result?.kind === 'done' ? (
        <Callout tone="ok" role="status">
          {tr('print.reprint.done', { seq: result.seq })}
        </Callout>
      ) : null}
      {result?.kind === 'offline' ? (
        <Callout tone="warn" role="alert">
          {tr('print.reprint.offline')}
        </Callout>
      ) : null}
      {result?.kind === 'error' ? (
        <Callout tone="bad" role="alert">
          {errorText(tr, result.error)}
        </Callout>
      ) : null}
    </div>
  );
}
