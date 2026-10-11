import { formatBaht } from '@sds/i18n';
import type { PaymentStatus, SlipCheck, SlipRecipientCheck } from '@sds/shared';
import { useEffect, useState } from 'react';
import { s } from '../design/style.ts';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { Callout } from './PayParts.tsx';

const CHIP_TONE: Record<SlipCheck, string> = {
  match: 'g-b-ok',
  mismatch: 'g-b-warn',
  unreadable: 'g-b-mute',
  pending: 'g-b-mute',
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
  onCheck,
  quiet = false,
}: {
  orderId: string;
  paymentId: string;
  rev: number;
  /** What this payment charges, to put beside the amount read from the slip. */
  amountSatang: number;
  /** Tells the payment screen how the reading stands (null: no reading) and whether the slip was used before, so it can ask for an extra tap. */
  onCheck?: (state: {
    check: SlipCheck | null;
    duplicate: boolean;
    recipientMismatch: boolean;
  }) => void;
  /** In the payment history: say nothing when there is no slip (only a payment with one shows it). */
  quiet?: boolean;
}) {
  const tr = useT();
  const locale = useLocale();
  const { api } = useServices();
  const [hint, setHint] = useState<{
    check: SlipCheck;
    amountSatang: number | null;
    qrFound: boolean | undefined;
    recipient: SlipRecipientCheck | undefined;
  } | null>(null);
  const [duplicate, setDuplicate] = useState<SlipDuplicate | null>(null);
  // `unknown`: the list could not be read, so the button is offered as before.
  const [known, setKnown] = useState<'checking' | 'has' | 'missing' | 'unknown'>('checking');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle');
  const [url, setUrl] = useState<string | null>(null);

  // `rev` is a dependency on purpose: a new revision of the payment may mean a slip arrived.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    api.payments
      .list(orderId)
      .then((answer) => {
        if (!live) return;
        const has = answer.slipPaymentIds?.includes(paymentId) === true;
        setKnown(has ? 'has' : 'missing');
        const found = has ? answer.slipChecks?.find((c) => c.paymentId === paymentId) : undefined;
        setHint(
          found
            ? {
                check: found.check,
                amountSatang: found.amountSatang,
                qrFound: found.qrFound,
                recipient: found.recipientCheck,
              }
            : null,
        );
        const used = has
          ? answer.slipDuplicates?.find((d) => d.paymentId === paymentId)
          : undefined;
        setDuplicate(
          used
            ? {
                orderNo: used.orderNo,
                paymentStatus: used.paymentStatus,
                matchedBy: used.matchedBy,
              }
            : null,
        );
        onCheck?.({
          check: found?.check ?? null,
          duplicate: used !== undefined,
          recipientMismatch: found?.recipientCheck === 'mismatch',
        });
      })
      .catch(() => {
        if (live) setKnown('unknown');
      });
    return () => {
      live = false;
    };
  }, [api, orderId, paymentId, rev]);

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
  if (known === 'missing') {
    if (quiet) return null;
    return (
      <p className="g-t-c" role="status" data-testid="slip-missing" style={s('margin:0')}>
        {tr('payment.slip.missing')}
      </p>
    );
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
      {known === 'has' ? (
        <p className="g-t-c" data-testid="slip-has" style={s('margin:0;font-weight:600')}>
          {tr('payment.slip.has')}
          {hint ? (
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
      {known === 'has' && hint && !quiet ? (
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
