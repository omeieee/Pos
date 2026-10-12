import { formatBaht, type MessageKey } from '@sds/i18n';
import type {
  OrderPaymentsResponse,
  PaymentStatus,
  SlipCheck,
  SlipRecipientCheck,
  SlipVerifyVerdict,
} from '@sds/shared';
import { useEffect, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { Callout } from './PayParts.tsx';
import { SlipAlerts } from './SlipAlerts.tsx';
import {
  canRecheckSlip,
  NO_ALERTS,
  recheckErrorKey,
  type SlipAlerts as SlipAlertFacts,
  type SlipFacts,
  showNoSlipFlag,
  slipAlertsOf,
  slipIsBankMatched,
} from './slip-gate.ts';

const CHIP_TONE: Record<SlipCheck, string> = {
  match: 'g-b-ok',
  mismatch: 'g-b-warn',
  unreadable: 'g-b-mute',
  pending: 'g-b-mute',
};

const VERIFY_TONE: Record<SlipVerifyVerdict, 'ok' | 'warn' | 'bad' | 'mute'> = {
  valid: 'ok',
  amount_mismatch: 'warn',
  date_mismatch: 'warn',
  receiver_mismatch: 'bad',
  not_found: 'bad',
  fraud: 'bad',
  pending: 'mute',
  unchecked: 'mute',
};

/** What the server says about a slip that was used before (D-26), as a hint: never a decision. */
export interface SlipDuplicate {
  orderNo: string;
  paymentStatus: PaymentStatus;
  /** What matched; `qr` is the reference inside the slip's own QR. */
  matchedBy?: 'qr' | 'ref' | 'image' | undefined;
}

/**
 * The customer's slip for a PromptPay payment, in any status while the file exists (90-day
 * retention; after that the server answers "not found", which is said plainly). The payment list answer says which payments have a
 * picture, so the button shows only then; it is asked again whenever the payment changes (a slip
 * comes with the claim, which is a new revision). Staff open the picture on request; it comes with
 * the session header, lives in a blob URL for as long as it is shown and is never stored. It is only
 * a hint: the money is confirmed from the bank app (rule 2).
 *
 * The server also reads the amount off the picture (D-26) and the answer comes with the same list:
 * a green, amber or grey banner and a small chip. That is a second hint, never a decision: it says
 * so, and the confirm button still needs the bank app. The reading finishes after the claim, with a
 * new revision of the payment, which asks again.
 *
 * A slip whose picture or bank reference was already used on an earlier payment gets a strong red
 * banner above the amount banner (and a chip). It is the same kind of hint: automatic, and the bank
 * app still decides. It names only that order's number and the status of its payment.
 */
export function SlipView({
  orderId,
  paymentId,
  rev,
  amountSatang,
  status = 'claimed',
  onCheck,
  customerId,
  quiet = false,
}: {
  orderId: string;
  paymentId: string;
  rev: number;
  /** What this payment charges, to put beside the amount read from the slip. */
  amountSatang: number;
  /** The payment's status: the re-check is offered only while it is claimed. */
  status?: PaymentStatus;
  /**
   * Tells the payment screen what is known about the slip (whether there is one, the amount and
   * receiver readings, whether it was used before), so it can ask for the "I checked the bank app"
   * tick. When the list cannot be read the slip is reported as present and unverified: the screen
   * then asks for the tick (fail closed).
   */
  onCheck?: (facts: SlipFacts) => void;
  /** The order's customer, for the owner's "clear customer flag" button. */
  customerId?: string | null | undefined;
  /** In the payment history: say nothing when there is no slip (only a payment with one shows it). */
  quiet?: boolean;
}) {
  const tr = useT();
  const locale = useLocale();
  const { api } = useServices();
  const [hint, setHint] = useState<{
    /** The OCR amount reading; null when OCR is off (no OCR banner or chip then). */
    check: SlipCheck | null;
    verdict: SlipVerifyVerdict | null;
    amountSatang: number | null;
    qrFound: boolean | undefined;
    recipient: SlipRecipientCheck | undefined;
  } | null>(null);
  const [duplicate, setDuplicate] = useState<SlipDuplicate | null>(null);
  // `unknown`: the list could not be read, so the button is offered as before.
  const [known, setKnown] = useState<'checking' | 'has' | 'missing' | 'unknown'>('checking');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [noSlipClaim, setNoSlipClaim] = useState(false);
  const [facts, setFacts] = useState<SlipFacts | null>(null);
  const [alerts, setAlerts] = useState<SlipAlertFacts>(NO_ALERTS);
  // Bumped after an owner's clear, so the list is read again.
  const [reloads, setReloads] = useState(0);
  const [recheck, setRecheck] = useState<{ busy: boolean; error: MessageKey | null }>({
    busy: false,
    error: null,
  });

  /** Takes in a payment list answer: the list itself, or the answer of a re-check. */
  function apply(answer: OrderPaymentsResponse) {
    const has = answer.slipPaymentIds?.includes(paymentId) === true;
    setKnown(has ? 'has' : 'missing');
    setAlerts(slipAlertsOf(answer));
    setNoSlipClaim(!has && showNoSlipFlag(paymentId, answer.claimedWithoutSlipPaymentIds));
    const found = has ? answer.slipChecks?.find((c) => c.paymentId === paymentId) : undefined;
    setHint(
      found
        ? {
            check: found.check ?? null,
            verdict: found.verify?.verdict ?? null,
            amountSatang: found.amountSatang ?? null,
            qrFound: found.qrFound,
            recipient: found.recipientCheck,
          }
        : null,
    );
    const used = has ? answer.slipDuplicates?.find((d) => d.paymentId === paymentId) : undefined;
    setDuplicate(
      used
        ? { orderNo: used.orderNo, paymentStatus: used.paymentStatus, matchedBy: used.matchedBy }
        : null,
    );
    const next: SlipFacts = {
      hasSlip: has,
      check: found?.check ?? null,
      verdict: found?.verify?.verdict ?? null,
      recipient: found?.recipientCheck ?? null,
      duplicate: used !== undefined,
      ...(found?.verify?.reviewedAt !== undefined ? { reviewed: true } : {}),
    };
    setFacts(next);
    onCheck?.(next);
  }

  async function runRecheck() {
    setRecheck({ busy: true, error: null });
    try {
      apply(await api.payments.slipRecheck(paymentId));
      setRecheck({ busy: false, error: null });
    } catch (error) {
      setRecheck({ busy: false, error: recheckErrorKey((error as { code?: string }).code) });
    }
  }

  // `rev` is a dependency on purpose: a new revision of the payment may mean a slip arrived.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    api.payments
      .list(orderId)
      .then((answer) => {
        if (live) apply(answer);
      })
      .catch(() => {
        if (!live) return;
        setKnown('unknown');
        onCheck?.({ hasSlip: true, check: null, recipient: null, duplicate: false });
      });
    return () => {
      live = false;
    };
  }, [api, orderId, paymentId, rev, reloads]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  async function open() {
    setPhase('loading');
    try {
      setUrl(URL.createObjectURL(await api.payments.slip(paymentId)));
      setPhase('idle');
    } catch (error) {
      setPhase((error as { code?: string }).code === 'SLIP_NOT_FOUND' ? 'none' : 'failed');
    }
  }

  if (known === 'checking') return null;
  const alertsView =
    known !== 'unknown' && !quiet ? (
      <SlipAlerts
        alerts={alerts}
        reviewed={facts?.reviewed === true}
        paymentId={paymentId}
        customerId={customerId}
        onCleared={() => setReloads((n) => n + 1)}
      />
    ) : null;
  if (known === 'missing') {
    if (quiet) return null;
    return (
      <div style={s('display:flex;flex-direction:column;gap:8px')}>
        {alertsView}
        {noSlipClaim ? (
          <div data-testid="no-slip-flag">
            <Callout tone="warn" role="alert">
              <span style={s('display:block;font-weight:700')}>{tr('pos.slipFlag.noSlip')}</span>
            </Callout>
          </div>
        ) : null}
        <p className="g-t-c" role="status" data-testid="slip-missing" style={s('margin:0')}>
          {tr('payment.slip.missing')}
        </p>
      </div>
    );
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
      {alertsView}
      {known === 'has' ? (
        <p className="g-t-c" data-testid="slip-has" style={s('margin:0;font-weight:600')}>
          {tr('payment.slip.has')}
          {hint?.verdict ? (
            <span
              className={`g-badge g-b-${VERIFY_TONE[hint.verdict]}`}
              data-testid="slip-verify-chip"
              style={s('margin-left:8px')}
            >
              {tr(`payment.slip.verify.chip.${hint.verdict}`)}
            </span>
          ) : null}
          {hint?.check ? (
            <span
              className={`g-badge ${CHIP_TONE[hint.check]}`}
              data-testid="slip-chip"
              style={s('margin-left:8px')}
            >
              {tr(`payment.slip.chip.${hint.check}`)}
            </span>
          ) : null}
          {hint?.recipient === 'match' || hint?.recipient === 'mismatch' ? (
            <span
              className={`g-badge ${hint.recipient === 'match' ? 'g-b-ok' : 'g-b-bad'}`}
              data-testid="slip-recipient-chip"
              style={s('margin-left:8px')}
            >
              {tr(`payment.slip.recipient.chip.${hint.recipient}`)}
            </span>
          ) : null}
          {duplicate ? (
            <span
              className="g-badge g-b-bad"
              data-testid="slip-duplicate-chip"
              style={s('margin-left:8px')}
            >
              {tr('payment.slip.chip.duplicate')}
            </span>
          ) : null}
        </p>
      ) : null}
      {known === 'has' && duplicate && !quiet ? (
        <div data-testid="slip-duplicate">
          <Callout tone="bad" role="alert">
            <span style={s('display:block;font-weight:700')}>
              {tr(
                duplicate.matchedBy === 'qr'
                  ? 'payment.slip.duplicateQr'
                  : 'payment.slip.duplicate',
                {
                  orderNo: duplicate.orderNo,
                  status: tr(`payment.status.${duplicate.paymentStatus}`),
                },
              )}
            </span>
            <span className="g-t-c" style={s('display:block;font-weight:500')}>
              {tr('payment.slip.check.hint')}
            </span>
          </Callout>
        </div>
      ) : null}
      {known === 'has' && facts && slipIsBankMatched(facts) && !quiet ? (
        <p
          className="g-badge g-b-ok"
          data-testid="slip-matched"
          role="status"
          style={s('margin:0;font-weight:700;align-self:flex-start')}
        >
          {tr('pos.slipMatched.title')}
        </p>
      ) : null}
      {known === 'has' && hint?.verdict && !quiet ? <VerifyBanner verdict={hint.verdict} /> : null}
      {known === 'has' && facts && !quiet && canRecheckSlip(status, facts) ? (
        <div style={s('display:flex;flex-direction:column;gap:6px')}>
          <button
            type="button"
            className="g-btn g-btn-sm"
            data-testid="slip-recheck"
            disabled={recheck.busy}
            aria-busy={recheck.busy}
            onClick={() => void runRecheck()}
          >
            {tr(recheck.busy ? 'pos.slipRecheck.busy' : 'pos.slipRecheck.button')}
          </button>
          {recheck.error ? (
            <p
              className="g-t-c"
              role="alert"
              data-testid="slip-recheck-error"
              style={s('margin:0')}
            >
              {tr(recheck.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {known === 'has' && hint?.recipient === 'mismatch' && !quiet ? (
        <div data-testid="slip-recipient" data-recipient="mismatch">
          <Callout tone="bad" role="alert">
            <span style={s('display:block;font-weight:700')}>
              {tr('payment.slip.recipient.mismatch')}
            </span>
            <span className="g-t-c" style={s('display:block;font-weight:500')}>
              {tr('payment.slip.check.hint')}
            </span>
          </Callout>
        </div>
      ) : null}
      {known === 'has' && hint?.recipient === 'unknown' && !quiet ? (
        <p className="g-t-c" data-testid="slip-recipient" role="status" style={s('margin:0')}>
          {tr('payment.slip.recipient.unknown')}
        </p>
      ) : null}
      {known === 'has' && hint?.check && !quiet ? (
        <div data-testid="slip-check" data-check={hint.check}>
          {hint.check === 'match' || hint.check === 'mismatch' ? (
            <Callout tone={hint.check === 'match' ? 'ok' : 'warn'} role="status">
              <span style={s('display:block')}>
                {hint.check === 'match'
                  ? tr('payment.slip.check.match', { amount: formatBaht(amountSatang, locale) })
                  : tr('payment.slip.check.mismatch', {
                      slip: formatBaht(hint.amountSatang ?? 0, locale),
                      expected: formatBaht(amountSatang, locale),
                    })}
              </span>
              <span className="g-t-c" style={s('display:block;font-weight:500')}>
                {tr('payment.slip.check.hint')}
              </span>
            </Callout>
          ) : (
            <div className="g-sunk" role="status" style={s('padding:10px 12px;border-radius:14px')}>
              <span className="g-t-s" style={s('display:block;font-weight:600')}>
                {tr(`payment.slip.check.${hint.check}`)}
              </span>
              <span className="g-t-c" style={s('display:block')}>
                {tr('payment.slip.check.hint')}
              </span>
            </div>
          )}
        </div>
      ) : null}
      {known === 'has' && hint && hint.check !== 'pending' && hint.qrFound === false && !quiet ? (
        <p className="g-t-c" data-testid="slip-no-qr" style={s('margin:0')}>
          {tr('payment.slip.noQr')}
        </p>
      ) : null}
      {url ? (
        <>
          <img
            src={url}
            alt={tr('payment.slip.alt')}
            style={s('max-width:100%;max-height:60vh;object-fit:contain;border-radius:12px')}
          />
          <p className="g-t-c" style={s('margin:0')}>
            {tr('payment.slip.warning')}
          </p>
        </>
      ) : (
        <button
          type="button"
          className="g-btn g-btn-sm"
          disabled={phase === 'loading'}
          onClick={() => void open()}
        >
          {tr('payment.slip.view')}
        </button>
      )}
      {phase === 'none' ? (
        <p className="g-t-c" role="status" style={s('margin:0')}>
          {tr('payment.slip.none')}
        </p>
      ) : null}
      {phase === 'failed' ? (
        <p className="g-t-c" role="alert" style={s('margin:0')}>
          {tr('payment.slip.failed')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The bank check's answer (D-27, Slip2Go) as one banner. It says it is automatic and, but for a
 * valid slip, never reads as a decision: staff still confirm (the gate only decides whether the
 * tick is needed). `fraud` is the strongest one.
 */
function VerifyBanner({ verdict }: { verdict: SlipVerifyVerdict }) {
  const tr = useT();
  const tone = VERIFY_TONE[verdict];
  const text = tr(`payment.slip.verify.${verdict}`);
  return (
    <div data-testid="slip-verify" data-verdict={verdict}>
      {tone === 'mute' ? (
        <div
          className="g-sunk"
          role="status"
          style={s('padding:10px 12px;border-radius:14px;display:flex;gap:8px;align-items:center')}
        >
          <Gi n="clock" size="sm" style={s('flex:none')} />
          <span className="g-t-s" style={s('font-weight:600')}>
            {text}
          </span>
        </div>
      ) : (
        <Callout
          tone={tone}
          role={tone === 'ok' ? 'status' : 'alert'}
          {...(verdict === 'fraud'
            ? { style: s('border:2px solid var(--chili-ink);font-size:16px') }
            : {})}
        >
          <span style={s('display:block;font-weight:700')}>{text}</span>
          <span className="g-t-c" style={s('display:block;font-weight:500')}>
            {tr('payment.slip.verify.hint')}
          </span>
        </Callout>
      )}
    </div>
  );
}
