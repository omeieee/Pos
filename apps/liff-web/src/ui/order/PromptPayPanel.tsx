/**
 * Order page: pay by PromptPay (QR, claim, slip upload, cooldown).
 */
import { formatBaht } from '@sds/i18n';
import type { MyOrder, MyQrResponse } from '@sds/shared';
import { useCallback, useEffect, useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { browserSaveEnv, qrFileName, saveQrImage, toPng } from '../../model/qr-save.ts';
import { cooldownMinutes, useApp, useT } from '../app-context.tsx';
import { Notice } from '../Chrome.tsx';
import { QrViewer } from './QrViewer.tsx';
import { SentSlip } from './SentSlip.tsx';
import { SLIP_CHECK_KEY } from './status-maps.ts';

/**
 * The PromptPay step: the QR for this order's exact total, the "โอนแล้ว" button (which only tells
 * the shop; staff confirm the money by hand) and the note that says so.
 */
/**
 * Seconds left before another slip may be sent. The server's number (from the polled order) is
 * the source; this only counts it down on screen, so a wrong device clock changes nothing.
 */
function useCooldown(fromServer: number | undefined): number {
  const [left, setLeft] = useState(fromServer ?? 0);
  useEffect(() => {
    setLeft(fromServer ?? 0);
    if (!fromServer) return;
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [fromServer]);
  return left;
}

export function PromptPayPanel({
  order,
  busy,
  slipSent,
  slipStamp,
  onClaim,
  onSlip,
}: {
  order: MyOrder;
  busy: boolean;
  slipSent: boolean;
  slipStamp: number;
  onClaim: () => void;
  onSlip: (file: File) => void;
}) {
  const tr = useT();
  const { api, locale, platform } = useApp();
  const [qr, setQr] = useState<MyQrResponse | null>(null);
  const [failed, setFailed] = useState(false);
  /** The picture as a PNG made on this device, and the `blob:` link the page shows it from. */
  const [image, setImage] = useState<{ png: Blob; src: string } | null>(null);
  const [saved, setSaved] = useState<'downloaded' | null>(null);
  const [viewing, setViewing] = useState(false);
  const showQr = order.actions.showQr;
  const claimed = order.payment?.status === 'claimed';
  const orderId = order.id;
  const cooldown = useCooldown(order.slipRetryAfterSeconds);

  const fetchQr = useCallback(async () => {
    try {
      setQr(await api.qr(orderId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api, orderId]);

  useEffect(() => {
    if (!showQr) return;
    void fetchQr();
    // The link lasts five minutes: ask for a new one before it dies.
    const timer = setInterval(() => void fetchQr(), 4 * 60_000);
    return () => clearInterval(timer);
  }, [fetchQr, showQr]);

  // The QR is fetched once per link and redrawn as a PNG here. A `blob:` picture is on the page's
  // own origin, so a long-press in LINE's browser can save it; if the fetch fails the page keeps
  // showing the API's own link (the picture still appears, only "save" gets weaker).
  const qrUrl = qr?.url;
  useEffect(() => {
    if (!qrUrl) return;
    let cancelled = false;
    let made: string | null = null;
    void (async () => {
      try {
        const response = await fetch(api.absolute(qrUrl));
        if (!response.ok) throw new Error('qr');
        const png = await toPng(await response.blob());
        if (cancelled) return;
        made = URL.createObjectURL(png);
        setImage({ png, src: made });
      } catch {
        if (!cancelled) setImage(null);
      }
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, qrUrl]);

  /** Share sheet, then a plain download outside LINE, else show the picture large to press and hold. */
  async function save() {
    setSaved(null);
    if (!image) return setViewing(true);
    const outcome = await saveQrImage(
      image.png,
      qrFileName(order.orderNo),
      browserSaveEnv(platform.inLineClient(), qr ? api.absolute(qr.url) : undefined),
    );
    if (outcome === 'manual') setViewing(true);
    else if (outcome === 'downloaded') setSaved('downloaded');
  }

  const amount = qr ? formatBaht(qr.amountSatang, locale) : '';
  return (
    <>
      {showQr ? (
        <div
          className="g-glass2 g-rise"
          style={s(
            'border-radius:32px;padding:14px;display:flex;flex-direction:column;gap:12px;--d:.1s',
          )}
        >
          <div
            style={s('border-radius:24px;background:#fff;overflow:hidden;box-shadow:var(--sh1)')}
          >
            <div
              style={s(
                'background:#113566;color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between',
              )}
            >
              <b style={s('font-size:14px;letter-spacing:.04em')}>THAI QR PAYMENT</b>
              <span
                style={s(
                  'font-size:13px;font-weight:600;background:#fff;color:#113566;border-radius:6px;padding:1px 7px',
                )}
              >
                PromptPay
              </span>
            </div>
            <div
              style={s(
                'display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:center;padding:14px 16px',
              )}
            >
              {qr ? (
                <img
                  src={image?.src ?? api.absolute(qr.url)}
                  alt={tr('liff.qr.alt', { amount })}
                  width={158}
                  height={158}
                  style={s('width:158px;height:158px;flex:none')}
                  onError={() => void fetchQr()}
                />
              ) : (
                <div
                  className="g-sunk"
                  style={s(
                    'width:158px;height:158px;flex:none;display:grid;place-items:center;text-align:center;padding:8px',
                  )}
                >
                  {failed ? (
                    <button type="button" className="g-btn g-btn-sm" onClick={() => void fetchQr()}>
                      {tr('liff.qr.refresh')}
                    </button>
                  ) : (
                    <span className="g-t-c" role="status">
                      {tr('liff.loading')}
                    </span>
                  )}
                </div>
              )}
              <div
                style={s(
                  'display:flex;flex-direction:column;gap:2px;flex:1 1 120px;min-width:0;color:#1c1411',
                )}
              >
                <div className="g-t-c">{tr('liff.app.name')}</div>
                <div className="g-t-c" style={s('margin-top:6px')}>
                  {tr('liff.qr.amountLabel')}
                </div>
                <div
                  className="g-num"
                  style={s(
                    `font-size:${amount.length > 8 ? 24 : 32}px;line-height:1.25;font-weight:600;letter-spacing:-.01em`,
                  )}
                >
                  {amount}
                </div>
                <div className="g-t-c">{tr('liff.qr.thisOrderOnly')}</div>
              </div>
            </div>
          </div>
          <div className="g-t-s" style={s('padding:0 6px;color:var(--ink)')}>
            {tr('liff.qr.scanHelp')}
            {qr ? (
              <div className="g-t-c" style={s('margin-top:4px')}>
                {tr('liff.qr.id', { id: qr.promptpayId })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {claimed ? (
        <Notice icon="clock">
          <b>{tr('liff.order.claimedTitle')}</b>
          <br />
          {tr('liff.order.claimed')}
          {order.actions.attachSlip && !slipSent && order.slipCheck === undefined ? (
            <>
              <br />
              {tr('liff.order.claimedSlip')}
            </>
          ) : null}
        </Notice>
      ) : null}
      {claimed && order.slipCheck ? (
        <Notice icon={order.slipCheck === 'none' ? 'image' : 'clock'}>
          <span role="status">{tr(SLIP_CHECK_KEY[order.slipCheck])}</span>
        </Notice>
      ) : null}
      {slipSent ? (
        <Notice tone="ok" icon="check">
          {tr('liff.slip.sent')}
        </Notice>
      ) : null}

      {order.actions.attachSlip && cooldown > 0 ? (
        <Notice icon="clock">
          <span role="status">
            {tr('liff.error.SLIP_COOLDOWN', { minutes: cooldownMinutes(cooldown) })}
          </span>
        </Notice>
      ) : null}
      {order.slipBlocked && !order.actions.attachSlip ? (
        <Notice icon="bank">
          <span role="status">{tr('liff.error.SLIP_BLOCKED')}</span>
        </Notice>
      ) : null}

      {order.actions.claim || showQr || order.actions.attachSlip ? (
        <div className="g-rise" style={s('display:flex;flex-direction:column;gap:10px;--d:.16s')}>
          {order.actions.claim ? (
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              disabled={busy}
              aria-busy={busy}
              onClick={onClaim}
            >
              <Gi n="check" />
              {busy ? tr('liff.order.claiming') : tr('liff.order.claim')}
            </button>
          ) : null}
          {showQr || order.actions.attachSlip ? (
            <div style={s('display:flex;gap:10px')}>
              {showQr ? (
                <button
                  type="button"
                  className="g-btn"
                  style={s('flex:1')}
                  disabled={!qr}
                  onClick={() => void save()}
                >
                  <Gi n="download" size="sm" />
                  {tr('liff.qr.save')}
                </button>
              ) : null}
              {order.actions.attachSlip && cooldown > 0 ? (
                <button type="button" className="g-btn" style={s('flex:1')} disabled>
                  <Gi n="image" size="sm" />
                  {tr(order.hasSlip ? 'liff.slip.replace' : 'liff.qr.attachSlip')}
                </button>
              ) : order.actions.attachSlip ? (
                <label className="g-btn" style={s('flex:1;cursor:pointer')} aria-disabled={busy}>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) onSlip(file);
                    }}
                  />
                  <Gi n="image" size="sm" />
                  {tr(order.hasSlip ? 'liff.slip.replace' : 'liff.qr.attachSlip')}
                </label>
              ) : null}
            </div>
          ) : null}
          {order.hasSlip ? <SentSlip orderId={order.id} stamp={slipStamp} /> : null}
          {saved === 'downloaded' ? (
            <p className="g-t-c" role="status" style={s('margin:0;padding:0 6px')}>
              {tr('liff.qr.saved')}
            </p>
          ) : null}
        </div>
      ) : null}
      {viewing && qr ? (
        <QrViewer
          // Inside LINE the real file link, so "Save image" gets a file and not a page-made blob.
          src={
            platform.inLineClient() ? api.absolute(qr.url) : (image?.src ?? api.absolute(qr.url))
          }
          alt={tr('liff.qr.alt', { amount })}
          onClose={() => setViewing(false)}
        />
      ) : null}

      <div
        className="g-sunk g-rise"
        style={s('padding:12px 16px;display:flex;gap:10px;align-items:flex-start;--d:.2s')}
      >
        <Gi n="shieldCheck" size="sm" style={{ marginTop: 3, color: 'var(--ink2)' }} />
        <div className="g-t-s" style={s('line-height:1.55')}>
          {tr('liff.order.shopChecks')}
        </div>
      </div>
    </>
  );
}
