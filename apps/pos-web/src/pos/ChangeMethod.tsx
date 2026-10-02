import type { OrderDto, PaymentDto } from '@sds/shared';
import { useState } from 'react';
import { useActivityHold, useEntities, useNow, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { CashPanel } from './CashPanel.tsx';
import { MethodTiles } from './MethodTiles.tsx';
import { COPAY_TICK_MS, methodOptions, type PayMethod } from './payment-model.ts';
import { StartPanel } from './StartPanel.tsx';

/**
 * "Change how to pay": the waiting payment is cancelled and a new one made, in ONE call
 * (`change-method`). It never lists the payment's own method (the server refuses that), and the
 * button is only shown for a pending payment: a claimed one needs "money not found" first, and a
 * confirmed one a manager's void.
 */
export function ChangeMethod({
  order,
  payment,
  hidden,
  onAttempt,
}: {
  order: OrderDto;
  payment: PaymentDto;
  hidden: ReadonlySet<PayMethod>;
  onAttempt: (method: PayMethod) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        {tr('payment.change.button')}
      </button>
      {open ? (
        <ChangeSheet
          order={order}
          payment={payment}
          hidden={hidden}
          onAttempt={onAttempt}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ChangeSheet({
  order,
  payment,
  hidden,
  onAttempt,
  onClose,
}: {
  order: OrderDto;
  payment: PaymentDto;
  hidden: ReadonlySet<PayMethod>;
  onAttempt: (method: PayMethod) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const settings = useEntities().settings;
  const [selected, setSelected] = useState<PayMethod | null>(null);
  useActivityHold(true);

  const now = useNow(COPAY_TICK_MS);
  const options = methodOptions(order, settings, now, hidden).filter(
    (option) => option.method !== payment.method,
  );
  const choice = options.some((o) => o.method === selected && o.enabled) ? selected : null;

  return (
    <Modal labelledBy="change-title" onClose={onClose}>
      <h2 id="change-title" className="sheet__title">
        {tr('payment.change.title')}
      </h2>
      <p className="muted">{tr('payment.change.hint')}</p>
      <MethodTiles options={options} choice={choice} name="change-method" onChoose={setSelected} />
      {choice === 'cash' ? (
        <CashPanel order={order} changeFrom={payment.id} onAttempt={onAttempt} onDone={onClose} />
      ) : null}
      {choice === 'promptpay' || choice === 'gov_copay' ? (
        <StartPanel
          order={order}
          method={choice}
          changeFrom={payment.id}
          onAttempt={onAttempt}
          onDone={onClose}
          label={tr('payment.change.confirm', { method: tr(`payment.method.${choice}`) })}
        />
      ) : null}
      <button type="button" className="btn btn-soft btn-block" onClick={onClose}>
        {tr('common.cancel')}
      </button>
    </Modal>
  );
}
