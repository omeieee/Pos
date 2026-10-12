import { useRef, useState } from 'react';
import { newClientRequestId } from '../api/client.ts';
import { s } from '../design/style.ts';
import { useActivityHold, useAuthStore, useServices, useStaffRole, useT } from '../ui/hooks.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from './PayParts.tsx';
import {
  type SlipAlerts as Alerts,
  clearErrorKey,
  ownerSlipActions,
  slipClearReasonProblem,
} from './slip-gate.ts';

type Kind = 'block' | 'flag';

/**
 * The staff-only notices about a blocked slip and a flagged customer (D-27), and the owner's two
 * buttons to clear them. Both banners are hints: confirming stays available (rule 2), staff check
 * the bank app. The buttons show for the owner only; the server enforces it again with a step-up.
 */
export function SlipAlerts({
  alerts,
  reviewed,
  paymentId,
  customerId,
  onCleared,
}: {
  alerts: Alerts;
  /** The owner reviewed this slip by hand. */
  reviewed: boolean;
  paymentId: string;
  customerId: string | null | undefined;
  /** Called after a clear succeeded, so the view reads the list again. */
  onCleared: () => void;
}) {
  const tr = useT();
  const owner = useStaffRole() === 'owner';
  const [asking, setAsking] = useState<Kind | null>(null);
  const actions = ownerSlipActions(owner, alerts, customerId);
  if (!alerts.blocked && alerts.flagCount === null && !reviewed) return null;
  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')} data-testid="slip-alerts">
      {alerts.blocked ? (
        <div data-testid="slip-block-banner">
          <Callout
            tone="bad"
            role="alert"
            style={s('border:2px solid var(--chili-ink);font-size:16px')}
          >
            {tr('pos.slipBlock.banner')}
          </Callout>
        </div>
      ) : null}
      {alerts.flagCount !== null ? (
        <div data-testid="slip-flag-banner">
          <Callout tone="warn" role="alert">
            {tr('pos.slipFlag2.banner', { count: alerts.flagCount })}
          </Callout>
        </div>
      ) : null}
      {reviewed ? (
        <p
          className="g-badge g-b-mute"
          data-testid="slip-reviewed"
          role="status"
          style={s('margin:0;align-self:flex-start;font-weight:700')}
        >
          {tr('pos.slipBlock.reviewed')}
        </p>
      ) : null}
      {actions.clearBlock || actions.clearFlag ? (
        <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
          {actions.clearBlock ? (
            <button
              type="button"
              className="g-btn g-btn-sm"
              data-testid="slip-block-clear"
              onClick={() => setAsking('block')}
            >
              {tr('pos.slipBlock.clear.button')}
            </button>
          ) : null}
          {actions.clearFlag ? (
            <button
              type="button"
              className="g-btn g-btn-sm"
              data-testid="slip-flag-clear"
              onClick={() => setAsking('flag')}
            >
              {tr('pos.slipFlag2.clear.button')}
            </button>
          ) : null}
        </div>
      ) : null}
      {asking ? (
        <ClearDialog
          kind={asking}
          paymentId={paymentId}
          customerId={customerId}
          onClose={() => setAsking(null)}
          onCleared={() => {
            setAsking(null);
            onCleared();
          }}
        />
      ) : null}
    </div>
  );
}

/** The reason, then the step-up, then the call; closed only by the person or by success. */
function ClearDialog({
  kind,
  paymentId,
  customerId,
  onClose,
  onCleared,
}: {
  kind: Kind;
  paymentId: string;
  customerId: string | null | undefined;
  onClose: () => void;
  onCleared: () => void;
}) {
  const tr = useT();
  const { api } = useServices();
  const auth = useAuthStore();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request id per dialog: a retry of the same press is the same request (idempotent).
  const requestId = useRef(newClientRequestId());
  const problem = slipClearReasonProblem(reason);
  // The typed reason and the step-up must not be lost to a page reload.
  useActivityHold(true);

  async function submit() {
    if (problem !== null || busy) return;
    setBusy(true);
    setError(null);
    const input = { clientRequestId: requestId.current, reason: reason.trim() };
    const done = await auth.runSensitive(async () => {
      if (kind === 'block') await api.payments.slipBlockClear(paymentId, input);
      else await api.payments.slipFlagClear(customerId ?? '', input);
    });
    setBusy(false);
    if (done.ok) {
      onCleared();
      return;
    }
    // No error: the owner closed the step-up. Anything else is the server's own answer.
    if (done.error === null) return;
    setError(tr(clearErrorKey((done.error as { code?: string }).code)));
  }

  return (
    <PayModal labelledBy="slip-clear-title" onClose={() => (busy ? undefined : onClose())}>
      <SheetBody>
        <SheetTitle id="slip-clear-title">
          {tr(kind === 'block' ? 'pos.slipBlock.clear.title' : 'pos.slipFlag2.clear.title')}
        </SheetTitle>
        <Callout tone="warn" icon="shieldCheck">
          {tr('pos.slipBlock.clear.body')}
        </Callout>
        <TextRow
          id="slip-clear-reason"
          label={tr('pos.slipBlock.reason.label')}
          value={reason}
          disabled={busy}
          onChange={setReason}
        />
        <p className="g-t-c" style={s('margin:0')}>
          {tr('pos.slipBlock.reason.warn')}
        </p>
        {problem === 'tooLong' ? (
          <p
            className="g-t-c"
            role="alert"
            data-testid="slip-clear-reason-error"
            style={s('margin:0')}
          >
            {tr('pos.slipBlock.reason.tooLong')}
          </p>
        ) : null}
        {error ? (
          <Callout tone="bad" role="alert">
            <span data-testid="slip-clear-error">{error}</span>
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          data-testid="slip-clear-submit"
          disabled={busy || problem !== null}
          aria-busy={busy}
          onClick={() => void submit()}
        >
          {tr(busy ? 'pos.slipBlock.busy' : 'pos.slipBlock.submit')}
        </button>
        <button type="button" className="g-btn g-btn-block" disabled={busy} onClick={onClose}>
          {tr('common.cancel')}
        </button>
      </SheetBody>
    </PayModal>
  );
}
