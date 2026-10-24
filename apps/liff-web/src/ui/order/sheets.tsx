/**
 * The question sheets of the order and checkout screens: cancel, combine orders, amount mismatch,
 * and the open-order warning. They only show what the model decided and call back; every rule
 * (who may edit, what merges, what the amount is) lives in `model/` and on the server.
 */
import { formatBaht } from '@sds/i18n';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import type { CheckoutWarning } from '../../model/open-orders.ts';
import { orderNoList } from '../../model/open-orders.ts';
import { useApp, useT } from '../app-context.tsx';
import { PopupShell } from './popups.tsx';

const stack = s('display:flex;flex-direction:column;gap:10px;width:100%');

/** "Cancel order #L-001?" with a confirm and a way back. */
export function CancelSheet({
  orderNo,
  busy,
  onConfirm,
  onClose,
}: {
  orderNo: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <PopupShell titleId="cancel-title" onClose={onClose}>
      <Gi n="warn" size="lg" style={{ color: 'var(--ink2)' }} />
      <h2 id="cancel-title" className="g-t-2" style={s('margin:0')}>
        {tr('liff.cancel.title', { orderNo })}
      </h2>
      <p className="g-t-3" style={s('margin:0')}>
        {tr('liff.cancel.body')}
      </p>
      <div style={stack}>
        <button
          type="button"
          className="g-btn g-btn-p g-btn-block"
          disabled={busy}
          aria-busy={busy}
          onClick={onConfirm}
        >
          {busy ? tr('liff.cancel.working') : tr('liff.cancel.confirm')}
        </button>
        <button type="button" className="g-btn g-btn-block" disabled={busy} onClick={onClose}>
          {tr('liff.cancel.keep')}
        </button>
      </div>
    </PopupShell>
  );
}

/** The slip's amount equals this order plus others: combine them into one? */
export function CombineSheet({
  totalSatang,
  orderNos,
  busy,
  onYes,
  onNo,
}: {
  totalSatang: number;
  orderNos: readonly string[];
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  const tr = useT();
  const { locale } = useApp();
  return (
    <PopupShell titleId="combine-title" onClose={onNo}>
      <Gi n="info" size="lg" style={{ color: 'var(--ink2)' }} />
      <h2 id="combine-title" className="g-t-2" style={s('margin:0')}>
        {tr('liff.combine.title', {
          amount: formatBaht(totalSatang, locale),
          orders: orderNoList(orderNos),
        })}
      </h2>
      <p className="g-t-3" style={s('margin:0')}>
        {tr('liff.combine.body')}
      </p>
      <div style={stack}>
        <button
          type="button"
          className="g-btn g-btn-p g-btn-block"
          disabled={busy}
          aria-busy={busy}
          onClick={onYes}
        >
          {busy ? tr('liff.combine.working') : tr('liff.combine.yes')}
        </button>
        <button type="button" className="g-btn g-btn-block" disabled={busy} onClick={onNo}>
          {tr('liff.combine.no')}
        </button>
      </div>
    </PopupShell>
  );
}

/** The customer would not combine: "amount does not match", send it to the shop anyway or pick again. */
export function MismatchSheet({
  busy,
  onReview,
  onPick,
  onClose,
}: {
  busy: boolean;
  onReview: () => void;
  onPick: (file: File) => void;
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <PopupShell titleId="mismatch-title" onClose={onClose}>
      <Gi n="warn" size="lg" style={{ color: 'var(--ink2)' }} />
      <h2 id="mismatch-title" className="g-t-2" style={s('margin:0')}>
        {tr('liff.mismatch.title')}
      </h2>
      <p className="g-t-3" style={s('margin:0')}>
        {tr('liff.mismatch.body')}
      </p>
      <div style={stack}>
        <button
          type="button"
          className="g-btn g-btn-p g-btn-block"
          disabled={busy}
          aria-busy={busy}
          onClick={onReview}
        >
          {tr('liff.mismatch.review')}
        </button>
        <label className="g-btn g-btn-block" style={s('cursor:pointer')} aria-disabled={busy}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onPick(file);
            }}
          />
          <Gi n="image" size="sm" />
          {tr('liff.mismatch.pick')}
        </label>
      </div>
    </PopupShell>
  );
}

/**
 * Checkout: the customer has an unpaid order. Step one asks whether to go on (louder when the
 * dishes are the same); step two offers to add to that order or make a separate one.
 */
export function OpenOrderSheet({
  step,
  warning,
  busy,
  onContinue,
  onView,
  onMerge,
  onSeparate,
  onClose,
}: {
  step: 'ask' | 'choose';
  warning: CheckoutWarning;
  busy: boolean;
  onContinue: () => void;
  onView: () => void;
  onMerge: () => void;
  onSeparate: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const { locale } = useApp();
  const { order } = warning;
  return (
    <PopupShell titleId="open-order-title" onClose={onClose}>
      <Gi n="info" size="lg" style={{ color: 'var(--ink2)' }} />
      {step === 'ask' ? (
        <>
          <h2 id="open-order-title" className="g-t-2" style={s('margin:0')}>
            {tr(warning.duplicate ? 'liff.openOrder.titleDuplicate' : 'liff.openOrder.title', {
              orderNo: order.orderNo,
              amount: formatBaht(order.totalSatang, locale),
            })}
          </h2>
          <div style={stack}>
            <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onContinue}>
              {tr('liff.openOrder.continue')}
            </button>
            <button type="button" className="g-btn g-btn-block" onClick={onView}>
              {tr('liff.openOrder.viewOld')}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id="open-order-title" className="g-t-2" style={s('margin:0')}>
            {tr('liff.openOrder.mergeTitle', { orderNo: order.orderNo })}
          </h2>
          <p className="g-t-3" style={s('margin:0')}>
            {tr('liff.openOrder.mergeHint')}
          </p>
          <div style={stack}>
            <button
              type="button"
              className="g-btn g-btn-p g-btn-block"
              disabled={busy}
              aria-busy={busy}
              onClick={onMerge}
            >
              {busy ? tr('liff.openOrder.merging') : tr('liff.openOrder.merge')}
            </button>
            <button
              type="button"
              className="g-btn g-btn-block"
              disabled={busy}
              onClick={onSeparate}
            >
              {tr('liff.openOrder.separate')}
            </button>
          </div>
        </>
      )}
    </PopupShell>
  );
}
